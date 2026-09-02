import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { Herdr } from "../src/client/herdr.ts";
import { loadNavigationTargets, parseNavigationMode } from "../src/navigation.ts";

const REPO_WORKTREES_PREFIX = "herdr-pickers-repo-worktrees-";
const REPO_WORKSPACES_PREFIX = "herdr-pickers-repo-workspaces-";
const TRACKED_REPOS_PREFIX = "herdr-pickers-tracked-repos-";
const CONFIG_PREFIX = "herdr-pickers-config-";
const SOURCE_PREFIX = "herdr-pickers-source-";

function herdrWith(handler: (args: readonly string[]) => string, commands: string[][] = []): Herdr {
  return new Herdr({ runner: async (argv) => {
    const args = argv.slice(1);
    commands.push([...args]);
    return { stdout: handler(args), stderr: "", exitCode: 0 };
  } });
}

describe("navigation modes", () => {
  test("parses all navigation modes and rejects unknown values", () => {
    for (const mode of ["all", "projects", "workspaces", "worktrees", "repo-worktrees", "repo-workspaces"] as const) {
      expect(parseNavigationMode(mode)).toBe(mode);
    }
    expect(() => parseNavigationMode("bad")).toThrow(/Valid modes/);
  });

  test("builds same-repository worktrees with open and unopened checkouts", async () => {
    const repo = mkdtempSync(join(tmpdir(), REPO_WORKTREES_PREFIX));
    const current = join(repo, "current");
    const main = join(repo, "main");
    const unopened = join(repo, "unopened");
    const herdr = herdrWith((args) => args[0] === "workspace"
      ? JSON.stringify({ result: { workspaces: [
        { workspace_id: "current", focused: true, worktree: { repo_root: repo, checkout_path: current, is_linked_worktree: true } },
        { workspace_id: "main", worktree: { repo_root: repo, checkout_path: main, is_linked_worktree: true } },
      ] } })
      : JSON.stringify({ result: { source: { repo_root: repo }, worktrees: [
        { path: repo, is_bare: true },
        { path: current, branch: "feature/current", open_workspace_id: "current" },
        { path: main, branch: "main", open_workspace_id: "main" },
        { path: unopened, branch: "feature/unopened" },
      ] } }));

    const targets = await loadNavigationTargets("repo-worktrees", {
      herdr,
      env: { HERDR_PICKERS_SOURCE_WORKSPACE_ID: "current" },
    });

    expect(targets.map((target) => target.kind === "worktree" ? [target.branch, target.existingWorkspaceId, target.current] : [])).toEqual([
      ["feature/current", "current", true],
      ["main", "main", false],
      ["feature/unopened", undefined, false],
    ]);
  });

  test("scopes repository workspaces from source provenance and still loads fallback scope", async () => {
    const repo = mkdtempSync(join(tmpdir(), REPO_WORKSPACES_PREFIX));
    const current = join(repo, "current");
    const other = join(repo, "other");
    mkdirSync(join(repo, ".git"));
    mkdirSync(current);
    mkdirSync(other);
    const commands: string[][] = [];
    const herdr = herdrWith((args) => args[0] === "workspace"
      ? JSON.stringify({ result: { workspaces: [
        { workspace_id: "current", focused: true, worktree: { repo_root: repo, checkout_path: current, is_linked_worktree: true } },
        { workspace_id: "main", worktree: { repo_root: repo, checkout_path: repo, is_linked_worktree: false } },
        { workspace_id: "other", worktree: { repo_root: repo, checkout_path: other, is_linked_worktree: true } },
        { workspace_id: "elsewhere", worktree: { repo_root: "/elsewhere", checkout_path: "/elsewhere/main", is_linked_worktree: true } },
      ] } })
      : JSON.stringify({ result: { source: { repo_root: repo }, worktrees: [] } }), commands);

    const targets = await loadNavigationTargets("repo-workspaces", {
      herdr,
      env: { HERDR_PICKERS_SOURCE_WORKSPACE_ID: "current" },
    });

    expect(targets.map((target) => target.kind === "workspace" ? target.workspaceId : "")).toEqual(["current", "main", "other"]);
    expect(targets.find((target) => target.kind === "workspace" && target.workspaceId === "current")?.current).toBe(true);
    expect(commands).toContainEqual(["worktree", "list", "--workspace", "current", "--json"]);
  });

  test("projects mirror only repositories Herdr tracks when roots are empty", async () => {
    const root = mkdtempSync(join(tmpdir(), TRACKED_REPOS_PREFIX));
    const api = join(root, "api");
    const apiAlias = join(root, "api-alias");
    const unopened = join(root, "unopened");
    const configDir = mkdtempSync(join(tmpdir(), CONFIG_PREFIX));
    mkdirSync(join(api, ".git"), { recursive: true });
    mkdirSync(join(unopened, ".git"), { recursive: true });
    symlinkSync(api, apiAlias);
    writeFileSync(join(configDir, "config.toml"), "[projects]\nroots = []\n", "utf-8");
    const herdr = herdrWith(() => JSON.stringify({ result: { workspaces: [
      { workspace_id: "w1", cwd: api, worktree: { repo_root: api, repo_name: "api", is_linked_worktree: false } },
      { workspace_id: "w2", cwd: apiAlias, worktree: { repo_root: apiAlias, repo_name: "api", is_linked_worktree: false } },
    ] } }));

    const targets = await loadNavigationTargets("projects", { herdr, env: { HERDR_PLUGIN_CONFIG_DIR: configDir } });

    expect(targets.map((target) => target.label)).toEqual(["api"]);
    expect(targets[0]?.kind === "project" ? targets[0].existingWorkspaceId : undefined).toBe("w1");
  });

  test("explicit roots widen project discovery", async () => {
    const root = mkdtempSync(join(tmpdir(), TRACKED_REPOS_PREFIX));
    const api = join(root, "api");
    const unopened = join(root, "unopened");
    const configDir = mkdtempSync(join(tmpdir(), CONFIG_PREFIX));
    mkdirSync(join(api, ".git"), { recursive: true });
    mkdirSync(join(unopened, ".git"), { recursive: true });
    writeFileSync(join(configDir, "config.toml"), `[projects]\nroots = ["${root}"]\n`, "utf-8");
    const herdr = herdrWith(() => JSON.stringify({ result: { workspaces: [
      { workspace_id: "w1", cwd: api, worktree: { repo_root: api, repo_name: "api", is_linked_worktree: false } },
    ] } }));

    const targets = await loadNavigationTargets("projects", { herdr, env: { HERDR_PLUGIN_CONFIG_DIR: configDir } });

    expect(targets.map((target) => target.label).sort()).toEqual(["api", "unopened"]);
  });

  test("all mode marks every source representation as current", async () => {
    const root = mkdtempSync(join(tmpdir(), SOURCE_PREFIX));
    const project = join(root, "api");
    const feature = join(root, "feature");
    const configDir = mkdtempSync(join(tmpdir(), CONFIG_PREFIX));
    mkdirSync(join(project, ".git"), { recursive: true });
    mkdirSync(join(feature, ".git"), { recursive: true });
    writeFileSync(join(configDir, "config.toml"), `[projects]\nroots = ["${root}"]\n`, "utf-8");
    const herdr = herdrWith((args) => args[0] === "workspace"
      ? JSON.stringify({ result: { workspaces: [
        { workspace_id: "w1", label: "api", cwd: project },
        { workspace_id: "w2", label: "feature", cwd: feature },
      ] } })
      : JSON.stringify({ result: { source: { repo_root: project }, worktrees: [
        { path: project, branch: "main" },
        { path: feature, branch: "feature" },
      ] } }));

    const targets = await loadNavigationTargets("all", {
      herdr,
      env: {
        HERDR_PLUGIN_CONFIG_DIR: configDir,
        HERDR_PICKERS_SOURCE_WORKSPACE_ID: "w1",
        HERDR_PICKERS_SOURCE_PANE_ID: "w1:p1",
      },
    });

    expect(targets.map((target) => [target.id, target.current]).sort()).toEqual([
      [`project:${realpathSync(project)}`, true],
      ["workspace:w1", true],
      [`worktree:${project}`, true],
      [`project:${realpathSync(feature)}`, false],
      ["workspace:w2", false],
      [`worktree:${feature}`, false],
    ].sort());
  });
});
