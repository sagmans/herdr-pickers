import type { CommandRunner } from "./client/herdr.ts";
import type { Herdr } from "./client/herdr.ts";
import { readWorkspaces, workspaceRepoRoots, type WorkspaceRecord, type WorktreeRecord } from "./client/types.ts";
import { loadConfig } from "./config/config.ts";
import { listProjects } from "./discovery/projects.ts";
import { listWorktreesForContext, listWorktreesForProjects } from "./discovery/worktrees.ts";
import {
  buildProjectTargets,
  buildWorkspaceTargets,
  buildWorktreeTargets,
  currentContextFromEnv,
  type CurrentContext,
  type PickerTarget,
} from "./catalog.ts";
import { canonicalPathKey } from "./util/paths.ts";

export type NavigationMode = "all" | "projects" | "workspaces" | "worktrees" | "repo-worktrees" | "repo-workspaces";
export type NavigationTarget = PickerTarget;

export interface NavigationRuntime {
  readonly herdr: Herdr;
  readonly gitRunner?: CommandRunner | undefined;
  readonly env?: Record<string, string | undefined> | undefined;
}

interface NavigationSources {
  readonly workspaces: readonly WorkspaceRecord[];
  readonly current: CurrentContext;
  readonly repositoryScopeKey: string | undefined;
  readonly projects: readonly string[];
  readonly worktrees: readonly WorktreeRecord[];
}

const VALID_MODES = "all, projects, workspaces, worktrees, repo-worktrees, repo-workspaces";

export function parseNavigationMode(value: string | undefined): NavigationMode {
  switch (value) {
    case "all":
    case "projects":
    case "workspaces":
    case "worktrees":
    case "repo-worktrees":
    case "repo-workspaces":
      return value;
    default:
      throw new Error(`Unknown herdr-pickers navigation mode '${value ?? ""}'. Valid modes: ${VALID_MODES}`);
  }
}

export async function loadNavigationTargets(
  mode: NavigationMode,
  runtime: NavigationRuntime,
): Promise<NavigationTarget[]> {
  const { workspaces, current, repositoryScopeKey, projects, worktrees } = await loadNavigationSources(mode, runtime);
  const targets: NavigationTarget[] = [];

  if (mode === "all" || mode === "projects") {
    targets.push(...buildProjectTargets(projects, workspaces, current));
  }
  if (mode === "all" || mode === "workspaces") {
    targets.push(...buildWorkspaceTargets(workspaces, current));
  }
  if (mode === "repo-workspaces") {
    targets.push(...buildWorkspaceTargets(workspaces, current).filter((target) => target.repoKey === repositoryScopeKey));
  }
  if (mode === "all" || mode === "worktrees" || mode === "repo-worktrees") {
    targets.push(...buildWorktreeTargets(worktrees, workspaces, current));
  }
  return targets;
}

async function loadNavigationSources(
  mode: NavigationMode,
  runtime: NavigationRuntime,
): Promise<NavigationSources> {
  const workspaces = needsWorkspaces(mode)
    ? readWorkspaces(await runtime.herdr.json(["workspace", "list"]))
    : [];
  const current = currentContextFromEnv(runtime.env);
  const workspaceScopeKey = mode === "repo-workspaces" ? sourceWorkspaceRepoKey(workspaces, current) : undefined;
  const scoped = needsWorktreeScope(mode)
    ? await listWorktreesForContext(current, runtime.herdr)
    : undefined;
  const repositoryScopeKey = workspaceScopeKey
    ?? (scoped?.sourceRepoRoot ? canonicalPathKey(scoped.sourceRepoRoot) : undefined);
  const projects = needsProjects(mode) ? resolveProjects(runtime.env, workspaces) : [];
  const worktrees = mode === "repo-worktrees"
    ? scoped?.worktrees ?? []
    : needsWorktrees(mode)
      ? await listWorktreesForProjects(projects, runtime.herdr, runtime.gitRunner)
      : [];
  return { workspaces, current, repositoryScopeKey, projects, worktrees };
}

// Empty config intentionally mirrors Herdr; explicit roots are the only opt-in
// to filesystem-wide discovery beyond repositories already represented there.
function resolveProjects(
  env: Record<string, string | undefined> | undefined,
  workspaces: readonly WorkspaceRecord[],
): string[] {
  const tracked = workspaceRepoRoots(workspaces).map(canonicalPathKey);
  const configured = loadConfig(env).projects.roots;
  const widened = configured.length > 0 ? [...tracked, ...listProjects(configured)] : tracked;
  return [...new Set(widened)].sort((left, right) => left.localeCompare(right));
}

function sourceWorkspaceRepoKey(
  workspaces: readonly WorkspaceRecord[],
  current: CurrentContext,
): string | undefined {
  if (!current.workspaceId) return undefined;
  const source = workspaces.find((workspace) => workspace.workspaceId === current.workspaceId);
  const repoRoot = source?.worktree?.repoRoot;
  return repoRoot ? canonicalPathKey(repoRoot) : source?.worktree?.repoKey;
}

function needsWorktreeScope(mode: NavigationMode): boolean {
  // Repo workspace loading keeps the scoped call even with provenance so
  // filtering remains aligned with Herdr's open-worktree view.
  return mode === "repo-worktrees" || mode === "repo-workspaces";
}

function needsProjects(mode: NavigationMode): boolean {
  return mode === "all" || mode === "projects" || mode === "worktrees";
}

function needsWorkspaces(mode: NavigationMode): boolean {
  return mode === "all"
    || mode === "projects"
    || mode === "workspaces"
    || mode === "worktrees"
    || mode === "repo-worktrees"
    || mode === "repo-workspaces";
}

function needsWorktrees(mode: NavigationMode): boolean {
  return mode === "all" || mode === "worktrees";
}
