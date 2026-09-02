import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { Herdr, HerdrJsonError, type CommandRunner } from "../src/client/herdr.ts";
import { listProjects } from "../src/discovery/projects.ts";
import { listGitWorktrees, listWorktreesForContext, listWorktreesForProject } from "../src/discovery/worktrees.ts";

const TEMP_PREFIX = "herdr-pickers-discovery-";

function tempDirectory(): string {
  return mkdtempSync(join(tmpdir(), TEMP_PREFIX));
}

describe("project discovery", () => {
  test("finds git projects under deduplicated roots", () => {
    const root = tempDirectory();
    const app = join(root, "app");
    mkdirSync(join(app, ".git"), { recursive: true });

    expect(listProjects([root, root])).toEqual([realpathSync(app)]);
  });

  test("finds bare Git repositories under roots", () => {
    const root = tempDirectory();
    const repo = join(root, "sample-repo.git");
    mkdirSync(join(repo, "objects"), { recursive: true });
    mkdirSync(join(repo, "refs"), { recursive: true });
    writeFileSync(join(repo, "HEAD"), "ref: refs/heads/main\n", "utf-8");

    expect(listProjects([root])).toEqual([realpathSync(repo)]);
  });

  test("skips inaccessible or missing roots", () => {
    expect(listProjects([join(tempDirectory(), "missing")])).toEqual([]);
  });
});

describe("worktree discovery", () => {
  test("loads only source repository without Git fallback", async () => {
    const commands: string[][] = [];
    const herdr = new Herdr({ runner: async (argv) => {
      commands.push(argv.slice(1));
      return {
        stdout: '{"result":{"source":{"repo_root":"/repo","source_workspace_id":"w1"},"worktrees":[{"path":"/repo/main","open_workspace_id":"w1"},{"path":"/repo/wt"}]}}',
        stderr: "",
        exitCode: 0,
      };
    } });

    const result = await listWorktreesForContext({ workspaceId: "w1", cwd: "/repo/wt" }, herdr);

    expect(commands).toEqual([["worktree", "list", "--workspace", "w1", "--json"]]);
    expect(result.sourceRepoRoot).toBe("/repo");
    expect(result.worktrees[1]?.repoRoot).toBe("/repo");
  });

  test("rejects unscoped lookup", async () => {
    const herdr = new Herdr({ runner: async () => { throw new Error("must not run"); } });

    await expect(listWorktreesForContext({}, herdr)).rejects.toThrow(/source workspace or cwd/);
  });

  test("parses git worktree porcelain", async () => {
    const runner: CommandRunner = async () => ({
      stdout: "worktree /repo/main\nbranch refs/heads/main\n\nworktree /repo/feature\nbranch refs/heads/feat/x\n\n",
      stderr: "",
      exitCode: 0,
    });

    const rows = await listGitWorktrees("/repo/main", runner);

    expect(rows.map((row) => row.path)).toEqual(["/repo/main", "/repo/feature"]);
    expect(rows[1]?.branch).toBe("feat/x");
  });

  test("uses Herdr worktree list when available", async () => {
    const herdr = new Herdr({ runner: async () => ({
      stdout: '{"result":{"source":{"repo_root":"/repo"},"worktrees":[{"path":"/repo/wt","branch":"feat/x"}]}}',
      stderr: "",
      exitCode: 0,
    }) });

    const rows = await listWorktreesForProject("/repo", herdr);

    expect(rows[0]?.repoRoot).toBe("/repo");
  });

  test("falls back to git when Herdr command fails", async () => {
    const herdr = new Herdr({ runner: async () => ({ stdout: "", stderr: "no server", exitCode: 1 }) });
    const rows = await listWorktreesForProject("/repo/main", herdr, async () => ({
      stdout: "worktree /repo/main\nbranch refs/heads/main\n",
      stderr: "",
      exitCode: 0,
    }));

    expect(rows[0]?.path).toBe("/repo/main");
  });

  test("does not hide malformed Herdr JSON", async () => {
    const herdr = new Herdr({ runner: async () => ({ stdout: "not json", stderr: "", exitCode: 0 }) });

    await expect(listWorktreesForProject("/repo/main", herdr, async () => ({
      stdout: "worktree /repo/main\nbranch refs/heads/main\n",
      stderr: "",
      exitCode: 0,
    }))).rejects.toThrow(HerdrJsonError);
  });
});
