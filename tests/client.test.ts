import { describe, expect, test } from "bun:test";

import { readWorkspaces, readWorktrees, workspaceRepoRoots } from "../src/client/types.ts";

describe("Herdr navigation adapters", () => {
  test("read workspaces preserves navigation metadata and tolerates extra fields", () => {
    const rows = readWorkspaces({ result: { workspaces: [{
      workspace_id: "w1",
      label: "api",
      cwd: "/repo",
      tab_count: 2,
      pane_count: 3,
      extra: true,
    }] } });

    expect(rows[0]).toMatchObject({
      workspaceId: "w1",
      label: "api",
      cwd: "/repo",
      tabCount: 2,
      paneCount: 3,
    });
  });

  test("read workspaces preserves unknown linked-worktree state", () => {
    const rows = readWorkspaces({ result: { workspaces: [{
      workspace_id: "w1",
      worktree: { repo_name: "sample-repo", repo_root: "/repo/sample-repo" },
    }] } });

    expect(rows[0]?.worktree?.isLinkedWorktree).toBeUndefined();
  });

  test("read worktrees includes source and open-workspace metadata", () => {
    const result = readWorktrees({ result: {
      source: { repo_root: "/repo", source_workspace_id: "w1" },
      worktrees: [{ path: "/repo/wt", branch: "feat/x", is_linked_worktree: true, open_workspace_id: "w2" }],
    } });

    expect(result.sourceRepoRoot).toBe("/repo");
    expect(result.sourceWorkspaceId).toBe("w1");
    expect(result.worktrees[0]).toMatchObject({ path: "/repo/wt", branch: "feat/x", openWorkspaceId: "w2" });
  });

  test("workspace repo roots are distinct, sorted, and path-backed", () => {
    const roots = workspaceRepoRoots([
      { workspaceId: "w1", worktree: { repoRoot: "/repo/sample-repo" } },
      { workspaceId: "w2", worktree: { repoRoot: "/repo/sample-repo" } },
      { workspaceId: "w3", worktree: { repoRoot: "/repo/aaa" } },
      { workspaceId: "w4", worktree: { repoKey: "opaque-id" } },
      { workspaceId: "w5" },
    ]);

    expect(roots).toEqual(["/repo/aaa", "/repo/sample-repo"]);
  });
});
