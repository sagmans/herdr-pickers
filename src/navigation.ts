// Navigation catalog loader for project, workspace, and worktree modes. It
// gathers Herdr, Git, and filesystem sources per reload; catalog.ts turns them
// into targets and rows.ts renders them.
import type { Herdr } from "./client/herdr.ts";
import { readWorkspaces, workspaceRepoRoots, type WorkspaceRecord, type WorktreeRecord } from "./client/types.ts";
import { loadConfig } from "./config/config.ts";
import { listProjects } from "./discovery/projects.ts";
import { listWorktreesForContext, listWorktreesForProjects, sourceRepositoryKey } from "./discovery/worktrees.ts";
import {
  buildProjectTargets,
  buildWorkspaceTargets,
  buildWorktreeTargets,
  type PickerTarget,
} from "./catalog.ts";
import { navigationModeSpec, type NavigationMode, type NavigationModeSpec } from "./modes.ts";
import type { CurrentContext } from "./context.ts";
import { canonicalPathKey } from "./util/paths.ts";
import type { CommandRunner } from "./util/subprocess.ts";

/** Navigation-mode alias so callers stay decoupled from the catalog's union name. */
export type NavigationTarget = PickerTarget;

/** Injected sources so tests and the smoke control Herdr, Git, and project roots. */
export interface NavigationRuntime {
  readonly signal?: AbortSignal | undefined;
  readonly herdr: Herdr;
  readonly gitRunner?: CommandRunner | undefined;
  /** Surface the picker was opened from; absent means no source to mark or scope by. */
  readonly context?: CurrentContext | undefined;
  /** Only locates plugin configuration when explicit project roots are absent. */
  readonly env?: Record<string, string | undefined> | undefined;
  readonly projectRoots?: readonly string[] | undefined;
}

interface NavigationSources {
  readonly workspaces: readonly WorkspaceRecord[];
  readonly current: CurrentContext;
  readonly repositoryScopeKey: string | undefined;
  readonly projects: readonly string[];
  readonly worktrees: readonly WorktreeRecord[];
}

/** Fresh catalog per call; there is no cache, so reload always reflects current Herdr and Git state. */
export async function loadNavigationTargets(
  mode: NavigationMode,
  runtime: NavigationRuntime,
): Promise<NavigationTarget[]> {
  const spec = navigationModeSpec(mode);
  const { workspaces, current, repositoryScopeKey, projects, worktrees } = await loadNavigationSources(spec, runtime);
  return spec.targetKinds.flatMap((kind): NavigationTarget[] => {
    switch (kind) {
      case "project":
        return buildProjectTargets(projects, workspaces, current);
      case "workspace": {
        const built = buildWorkspaceTargets(workspaces, current);
        return spec.repoScoped ? built.filter((target) => target.repoKey === repositoryScopeKey) : built;
      }
      case "worktree":
        // Scoped worktrees already come from the source repository's own list.
        return buildWorktreeTargets(worktrees, workspaces, current);
      default: {
        const exhaustive: never = kind;
        return exhaustive;
      }
    }
  });
}

async function loadNavigationSources(
  spec: NavigationModeSpec,
  runtime: NavigationRuntime,
): Promise<NavigationSources> {
  // Every navigation catalog marks or filters rows against open workspaces.
  const workspaces = readWorkspaces(await runtime.herdr.json(["workspace", "list"]));
  const current = runtime.context ?? {};
  // Repo workspace loading keeps the scoped call even with provenance so
  // filtering remains aligned with Herdr's open-worktree view.
  const scoped = spec.repoScoped
    ? await listWorktreesForContext(current, runtime.herdr, runtime.signal)
    : undefined;
  const repositoryScopeKey = scoped ? sourceRepositoryKey(workspaces, current, scoped.sourceRepoRoot) : undefined;
  // Unscoped worktree catalogs are discovered per project, so they need the project list too.
  const catalogWorktrees = spec.targetKinds.includes("worktree") && !spec.repoScoped;
  const projects = spec.targetKinds.includes("project") || catalogWorktrees ? resolveProjects(runtime, workspaces) : [];
  const worktrees = spec.repoScoped
    ? scoped?.worktrees ?? []
    : catalogWorktrees
      ? await listWorktreesForProjects(projects, runtime.herdr, runtime.gitRunner, runtime.signal)
      : [];
  return { workspaces, current, repositoryScopeKey, projects, worktrees };
}

// Empty config intentionally mirrors Herdr; explicit roots are the only opt-in
// to filesystem-wide discovery beyond repositories already represented there.
function resolveProjects(
  runtime: NavigationRuntime,
  workspaces: readonly WorkspaceRecord[],
): string[] {
  const tracked = workspaceRepoRoots(workspaces).map(canonicalPathKey);
  const configured = runtime.projectRoots ?? loadConfig(runtime.env).projects.roots;
  const widened = configured.length > 0 ? [...tracked, ...listProjects(configured)] : tracked;
  return [...new Set(widened)].sort((left, right) => left.localeCompare(right));
}
