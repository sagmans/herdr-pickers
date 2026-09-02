import { basename } from "node:path";

import { Herdr, HerdrCommandError } from "./client/herdr.ts";
import type { PickerTarget } from "./catalog.ts";

const RECOVERABLE_WORKTREE_ERROR = /not found|does not exist|no worktree|not a worktree|not linked/i;

export async function dispatchAgent(target: string, herdr: Herdr): Promise<void> {
  await herdr.run(["agent", "focus", target]);
}

export async function dispatchNavigationTarget(target: PickerTarget, herdr: Herdr): Promise<void> {
  switch (target.kind) {
    case "workspace":
      await herdr.run(["workspace", "focus", target.workspaceId]);
      return;
    case "project":
      if (target.existingWorkspaceId) {
        await herdr.run(["workspace", "focus", target.existingWorkspaceId]);
        return;
      }
      await herdr.run(["workspace", "create", "--cwd", target.path, "--label", basename(target.path), "--focus"]);
      return;
    case "worktree":
      if (target.existingWorkspaceId) {
        await herdr.run(["workspace", "focus", target.existingWorkspaceId]);
        return;
      }
      await openWorktreeOrWorkspace(target, herdr);
      return;
    default: {
      const exhaustive: never = target;
      throw new Error(`Unsupported navigation target: ${String(exhaustive)}`);
    }
  }
}

async function openWorktreeOrWorkspace(
  target: Extract<PickerTarget, { readonly kind: "worktree" }>,
  herdr: Herdr,
): Promise<void> {
  if (target.repoRoot) {
    try {
      await herdr.run(["worktree", "open", "--cwd", target.repoRoot, "--path", target.path, "--json", "--focus"]);
      return;
    } catch (error) {
      // Only stale or unlinked Herdr metadata permits direct workspace creation;
      // permission and runtime failures must remain visible.
      if (!(error instanceof HerdrCommandError) || !RECOVERABLE_WORKTREE_ERROR.test(error.stderr)) throw error;
    }
  }

  await herdr.run([
    "workspace",
    "create",
    "--cwd",
    target.path,
    "--label",
    target.branch ?? basename(target.path),
    "--focus",
  ]);
}
