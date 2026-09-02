import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import {
  buildAgentTargets,
  buildProjectTargets,
  buildWorkspaceTargets,
  buildWorktreeTargets,
} from "../src/catalog.ts";

const CATALOG_TEMP_PREFIX = "herdr-pickers-catalog-";
const BARE_TEMP_PREFIX = "herdr-pickers-bare-workspace-";

describe("navigation target builders", () => {
  test("project targets match canonical workspace paths and mark source rows", () => {
    const root = mkdtempSync(join(tmpdir(), CATALOG_TEMP_PREFIX));
    const realProject = join(root, "real");
    const linkedProject = join(root, "linked");
    const otherProject = join(root, "other");
    mkdirSync(realProject);
    mkdirSync(otherProject);
    symlinkSync(realProject, linkedProject);

    const targets = buildProjectTargets([realProject, otherProject], [
      { workspaceId: "source", cwd: linkedProject },
      { workspaceId: "other", cwd: otherProject },
    ], { workspaceId: "source" });

    expect(targets.map((target) => [target.path, target.existingWorkspaceId, target.current])).toEqual([
      [otherProject, "other", false],
      [realProject, "source", true],
    ]);
  });

  test("project targets stay current through subdirectory cwd ancestry", () => {
    const root = mkdtempSync(join(tmpdir(), CATALOG_TEMP_PREFIX));
    const project = join(root, "real");
    const other = join(root, "other");
    const nestedCwd = join(project, "src", "deep");
    mkdirSync(nestedCwd, { recursive: true });
    mkdirSync(other);

    const targets = buildProjectTargets([project, other], [], { cwd: nestedCwd });

    expect(targets.map((target) => [target.path, target.current])).toEqual([
      [other, false],
      [project, true],
    ]);
  });

  test("project targets do not match linked worktree repository roots", () => {
    const [target] = buildProjectTargets(["/repo/main"], [{
      workspaceId: "wt",
      worktree: { repoRoot: "/repo/main", checkoutPath: "/repo/wt" },
    }]);

    expect(target?.existingWorkspaceId).toBeUndefined();
  });

  test("workspace targets expose visible relation and detail but mark source", () => {
    const targets = buildWorkspaceTargets([{
      workspaceId: "source",
      label: "main",
      cwd: "/repo/sample-repo/main",
      worktree: { repoName: "sample-repo", branch: "main", isLinkedWorktree: true },
    }, {
      workspaceId: "feature",
      label: "herdr",
      cwd: "/repo/sample-repo/herdr",
      tabCount: 2,
      paneCount: 3,
      agentStatus: "idle",
      worktree: { repoName: "sample-repo", branch: "feat/herdr", isLinkedWorktree: true },
    }], { workspaceId: "source" });

    expect(targets.map((target) => target.workspaceId)).toEqual(["source", "feature"]);
    expect(targets[0]).toMatchObject({ current: true });
    expect(targets[1]).toMatchObject({
      current: false,
      label: "sample-repo ▸ herdr",
      detail: "feat/herdr",
      agentStatus: "agent idle",
    });
    expect(targets[1]?.detail).not.toContain("tabs");
    expect(targets[1]?.detail).not.toContain("panes");
  });

  test("workspace targets exclude bare roots without hiding linked checkouts", () => {
    const root = mkdtempSync(join(tmpdir(), BARE_TEMP_PREFIX));
    const bare = join(root, "sample-repo");
    const main = join(bare, "main");
    mkdirSync(join(bare, "objects"), { recursive: true });
    mkdirSync(join(bare, "refs"));
    mkdirSync(join(main, ".git"), { recursive: true });
    writeFileSync(join(bare, "HEAD"), "ref: refs/heads/main\n", "utf-8");

    const targets = buildWorkspaceTargets([
      { workspaceId: "bare", cwd: main, worktree: { repoRoot: bare, checkoutPath: bare, isLinkedWorktree: false } },
      { workspaceId: "main", cwd: bare, worktree: { repoRoot: bare, checkoutPath: main, isLinkedWorktree: true } },
    ]);

    expect(targets.map((target) => target.workspaceId)).toEqual(["main"]);
  });

  test("worktree targets exclude bare and prunable rows and mark source", () => {
    const targets = buildWorktreeTargets([
      { path: "/repo/current", repoRoot: "/repo", openWorkspaceId: "source", isBare: false, isDetached: false, isLinkedWorktree: true, isPrunable: false },
      { path: "/repo/main", repoRoot: "/repo", branch: "main", isBare: false, isDetached: false, isLinkedWorktree: false, isPrunable: false },
      { path: "/repo/bare", repoRoot: "/repo", isBare: true, isDetached: false, isLinkedWorktree: false, isPrunable: false },
      { path: "/repo/prunable", repoRoot: "/repo", isBare: false, isDetached: false, isLinkedWorktree: true, isPrunable: true },
    ], [], { workspaceId: "source" });

    expect(targets.map((target) => [target.path, target.current])).toEqual([
      ["/repo/current", true],
      ["/repo/main", false],
    ]);
    expect(targets[1]?.detail).toBe("main checkout");
  });

  test("worktree targets resolve already-open workspaces by id and canonical path", () => {
    const targets = buildWorktreeTargets([
      { path: "/repo/open-id", repoRoot: "/repo", openWorkspaceId: "w1", isBare: false, isDetached: false, isLinkedWorktree: true, isPrunable: false },
      { path: "/repo/open-path", repoRoot: "/repo", isBare: false, isDetached: false, isLinkedWorktree: true, isPrunable: false },
      { path: "/repo/unopened", repoRoot: "/repo", isBare: false, isDetached: true, isLinkedWorktree: true, isPrunable: false },
    ], [
      { workspaceId: "w1", worktree: { checkoutPath: "/repo/other", isLinkedWorktree: true } },
      { workspaceId: "w2", cwd: "/repo/open-path" },
    ]);

    expect(targets.map((target) => [target.path, target.existingWorkspaceId])).toEqual([
      ["/repo/open-id", "w1"],
      ["/repo/open-path", "w2"],
      ["/repo/unopened", undefined],
    ]);
    expect(targets[2]?.detail).toBe("detached");
  });

  test("agent targets trust the source pane id over stale focused flags", () => {
    const targets = buildAgentTargets([
      { target: "p1", paneId: "w:p1", label: "pi", focused: true },
      { target: "p2", paneId: "w:p2", label: "codex" },
    ], [], { paneId: "w:p2" }, { includeFocused: true });

    expect(targets.filter((target) => target.focused).map((target) => target.agentTarget)).toEqual(["p2"]);
  });

  test("agent targets fall back to focused flags without pane context", () => {
    const targets = buildAgentTargets([
      { target: "p1", paneId: "w:p1", label: "pi", focused: true },
      { target: "p2", paneId: "w:p2", label: "codex" },
    ], [], {}, { includeFocused: true });

    expect(targets.filter((target) => target.focused).map((target) => target.agentTarget)).toEqual(["p1"]);
  });
});
