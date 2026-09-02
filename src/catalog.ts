import { basename } from "node:path";

import type { AgentRecord, WorkspaceRecord, WorktreeRecord } from "./client/types.ts";
import { isBareRepository } from "./discovery/projects.ts";
import { canonicalPathKey, isPathWithin } from "./util/paths.ts";

export interface AgentTarget {
  readonly kind: "agent";
  readonly id: string;
  readonly agentTarget: string;
  readonly agentLabel: string;
  readonly worktree?: string | undefined;
  readonly status?: string | undefined;
  readonly cwd?: string | undefined;
  readonly focused: boolean;
  readonly repo?: string | undefined;
  readonly repoKey?: string | undefined;
  readonly boardLabel: string;
  readonly label: string;
  readonly workspaceId?: string | undefined;
  readonly tabId?: string | undefined;
  readonly paneId?: string | undefined;
}

export type TargetKind = "project" | "workspace" | "worktree";

interface NavigationTargetBase {
  readonly kind: TargetKind;
  readonly id: string;
  readonly label: string;
  readonly detail?: string | undefined;
  readonly current: boolean;
  readonly repo?: string | undefined;
  readonly repoKey?: string | undefined;
  readonly boardLabel?: string | undefined;
}

export interface ProjectTarget extends NavigationTargetBase {
  readonly kind: "project";
  readonly path: string;
  readonly existingWorkspaceId?: string | undefined;
}

export interface WorkspaceTarget extends NavigationTargetBase {
  readonly kind: "workspace";
  readonly workspaceId: string;
  readonly cwd?: string | undefined;
  readonly path?: string | undefined;
  readonly agentStatus?: string | undefined;
}

export interface WorktreeTarget extends NavigationTargetBase {
  readonly kind: "worktree";
  readonly path: string;
  readonly repoRoot?: string | undefined;
  readonly branch?: string | undefined;
  readonly existingWorkspaceId?: string | undefined;
}

export type PickerTarget = ProjectTarget | WorkspaceTarget | WorktreeTarget;

export interface CurrentContext {
  readonly workspaceId?: string | undefined;
  readonly tabId?: string | undefined;
  readonly paneId?: string | undefined;
  readonly cwd?: string | undefined;
}

export const CURRENT_CONTEXT_ENV = {
  workspaceId: "HERDR_PICKERS_SOURCE_WORKSPACE_ID",
  tabId: "HERDR_PICKERS_SOURCE_TAB_ID",
  paneId: "HERDR_PICKERS_SOURCE_PANE_ID",
  cwd: "HERDR_PICKERS_SOURCE_CWD",
} as const;

const HERDR_CONTEXT_ENV = {
  workspaceId: "HERDR_WORKSPACE_ID",
  tabId: "HERDR_TAB_ID",
  paneId: "HERDR_PANE_ID",
  activeWorkspaceId: "HERDR_ACTIVE_WORKSPACE_ID",
  activePaneCwd: "HERDR_ACTIVE_PANE_CWD",
} as const;

export function currentContextFromEnv(env: Record<string, string | undefined> | undefined): CurrentContext {
  return {
    workspaceId: nonEmpty(env?.[CURRENT_CONTEXT_ENV.workspaceId]) ?? nonEmpty(env?.[HERDR_CONTEXT_ENV.workspaceId]) ?? nonEmpty(env?.[HERDR_CONTEXT_ENV.activeWorkspaceId]),
    tabId: nonEmpty(env?.[CURRENT_CONTEXT_ENV.tabId]) ?? nonEmpty(env?.[HERDR_CONTEXT_ENV.tabId]),
    paneId: nonEmpty(env?.[CURRENT_CONTEXT_ENV.paneId]) ?? nonEmpty(env?.[HERDR_CONTEXT_ENV.paneId]),
    cwd: nonEmpty(env?.[CURRENT_CONTEXT_ENV.cwd]) ?? nonEmpty(env?.[HERDR_CONTEXT_ENV.activePaneCwd]) ?? nonEmpty(env?.PWD),
  };
}

export interface AgentTargetOptions {
  readonly includeFocused?: boolean | undefined;
}

export function buildAgentTargets(
  agents: readonly AgentRecord[],
  workspaces: readonly WorkspaceRecord[] = [],
  current: CurrentContext = {},
  options: AgentTargetOptions = {},
): AgentTarget[] {
  const workspaceById = indexWorkspacesById(workspaces);
  return uniqueBy(agents.filter((agent) => !shouldExcludeAgent(agent, current, options.includeFocused === true)), (agent) => agent.target).map((agent) => {
    const workspace = agent.workspaceId ? workspaceById.get(agent.workspaceId) : undefined;
    const worktree = agentWorktreeLabel(agent, workspace);
    return {
      kind: "agent",
      id: `agent:${agent.target}`,
      agentTarget: agent.target,
      agentLabel: agent.label,
      worktree,
      status: agent.status,
      cwd: agent.cwd,
      focused: isCurrentAgent(agent, workspace, current),
      repo: workspace ? workspaceRepoName(workspace) : undefined,
      repoKey: agentRepoKey(agent, workspace),
      boardLabel: worktree ?? agent.label,
      label: agentLabel(agent, workspace),
      workspaceId: agent.workspaceId,
      tabId: agent.tabId,
      paneId: agent.paneId,
    };
  });
}

export function buildWorkspaceTargets(
  workspaces: readonly WorkspaceRecord[],
  current: CurrentContext = {},
): WorkspaceTarget[] {
  return workspaces
    .filter((workspace) => !isBareRootWorkspace(workspace))
    .map((workspace) => ({
      kind: "workspace",
      id: `workspace:${workspace.workspaceId}`,
      workspaceId: workspace.workspaceId,
      repo: workspaceRepoName(workspace),
      repoKey: workspaceRepoKey(workspace),
      boardLabel: workspaceBoardLabel(workspace),
      label: workspaceLabelWithRelation(workspace),
      current: isCurrentWorkspace(workspace, current),
      detail: workspaceDetail(workspace),
      cwd: workspace.cwd,
      agentStatus: visibleAgentStatus(workspace.agentStatus),
      path: workspacePath(workspace),
    }));
}

export function buildProjectTargets(
  projects: readonly string[],
  workspaces: readonly WorkspaceRecord[],
  current: CurrentContext = {},
): ProjectTarget[] {
  const workspaceByPath = indexWorkspacesByPath(workspaces);
  return uniqueSorted(projects).flatMap((path): ProjectTarget[] => {
    const workspace = workspaceByPath.get(canonicalPathKey(path));
    const label = basename(path);
    return [{
      kind: "project",
      id: `project:${path}`,
      path,
      existingWorkspaceId: workspace?.workspaceId,
      current: isCurrentWorkspace(workspace, current) || isCurrentPath(path, current),
      repo: label,
      repoKey: canonicalPathKey(path),
      boardLabel: label,
      label,
    }];
  });
}

export function buildWorktreeTargets(
  worktrees: readonly WorktreeRecord[],
  workspaces: readonly WorkspaceRecord[],
  current: CurrentContext = {},
): WorktreeTarget[] {
  const workspaceByPath = indexWorkspacesByPath(workspaces);
  return uniqueBy(worktrees.filter((worktree) => !worktree.isBare && !worktree.isPrunable), (worktree) => worktree.path)
    .flatMap((worktree): WorktreeTarget[] => {
      const workspace = workspaceByPath.get(canonicalPathKey(worktree.path));
      return [{
        kind: "worktree",
        id: `worktree:${worktree.path}`,
        path: worktree.path,
        repoRoot: worktree.repoRoot,
        branch: worktree.branch,
        existingWorkspaceId: worktree.openWorkspaceId ?? workspace?.workspaceId,
        current: (!!current.workspaceId && worktree.openWorkspaceId === current.workspaceId)
          || isCurrentPath(worktree.path, current, workspace),
        repo: worktree.repoRoot ? basename(worktree.repoRoot) : undefined,
        repoKey: canonicalPathKey(worktree.repoRoot ?? worktree.path),
        boardLabel: worktreeBoardLabel(worktree),
        label: worktreeLabel(worktree),
        detail: worktreeDetail(worktree),
      }];
    });
}

export function workspaceRepoRoot(workspace: WorkspaceRecord): string | undefined {
  return workspace.worktree?.repoRoot;
}

function indexWorkspacesById(workspaces: readonly WorkspaceRecord[]): Map<string, WorkspaceRecord> {
  return new Map(workspaces.map((workspace) => [workspace.workspaceId, workspace]));
}

function workspacePath(workspace: WorkspaceRecord): string | undefined {
  return workspace.worktree?.checkoutPath ?? workspace.worktree?.path ?? workspace.cwd ?? workspace.worktree?.repoRoot;
}

function workspaceLabel(workspace: WorkspaceRecord): string {
  const path = workspacePath(workspace);
  return path ? basename(path) : workspace.workspaceId;
}

function indexWorkspacesByPath(workspaces: readonly WorkspaceRecord[]): Map<string, WorkspaceRecord> {
  const byPath = new Map<string, WorkspaceRecord>();
  const index = (workspace: WorkspaceRecord, paths: readonly (string | undefined)[]) => {
    for (const path of paths) {
      if (!path) continue;
      const key = canonicalPathKey(path);
      if (!byPath.has(key)) byPath.set(key, workspace);
    }
  };

  // Checkout provenance stays stable while pane cwd can move within a repo.
  for (const workspace of workspaces) {
    const provenance = [
      workspace.worktree?.checkoutPath,
      workspace.worktree?.path,
      workspace.worktree?.isLinkedWorktree === false ? workspace.worktree.repoRoot : undefined,
    ];
    index(workspace, provenance);
    if (!provenance.some((path) => path !== undefined)) index(workspace, [workspace.cwd]);
  }
  return byPath;
}

function isBareRootWorkspace(workspace: WorkspaceRecord): boolean {
  const checkoutPath = workspace.worktree?.checkoutPath
    ?? workspace.worktree?.path
    ?? (workspace.worktree?.isLinkedWorktree === false ? workspace.worktree.repoRoot : undefined)
    ?? workspace.cwd;
  return checkoutPath !== undefined && isBareRepository(checkoutPath);
}

function workspaceBoardLabel(workspace: WorkspaceRecord): string {
  return workspace.label ?? workspaceLabel(workspace);
}

function workspaceRepoName(workspace: WorkspaceRecord): string | undefined {
  return workspace.worktree?.repoName ?? (workspace.worktree?.repoRoot ? basename(workspace.worktree.repoRoot) : undefined);
}

function workspaceRepoKey(workspace: WorkspaceRecord): string | undefined {
  if (workspace.worktree?.repoRoot) return canonicalPathKey(workspace.worktree.repoRoot);
  if (workspace.worktree?.repoKey) return workspace.worktree.repoKey;
  return workspace.cwd ? canonicalPathKey(workspace.cwd) : undefined;
}

function shouldExcludeAgent(agent: AgentRecord, current: CurrentContext, includeFocused: boolean): boolean {
  if (!includeFocused && agent.focused === true) return true;
  return !includeFocused && !!current.paneId && (agent.paneId === current.paneId || agent.target === current.paneId);
}

function workspaceLabelWithRelation(workspace: WorkspaceRecord): string {
  const name = workspaceBoardLabel(workspace);
  const repo = workspace.worktree?.repoName;
  const linked = workspace.worktree?.isLinkedWorktree;
  if (repo && linked === true) {
    const checkoutName = basename(workspace.worktree?.checkoutPath ?? workspace.worktree?.path ?? workspace.cwd ?? name);
    const worktreeName = name !== repo ? name : checkoutName;
    return worktreeName && worktreeName !== repo ? `${repo} ▸ ${worktreeName}` : `${repo} ▸ worktree`;
  }
  if (repo && linked === false && repo !== name) return `${repo} (${name})`;
  return name;
}

function workspaceDetail(workspace: WorkspaceRecord): string | undefined {
  const branch = workspace.worktree?.branch;
  return joinDetail(
    checkoutKind(workspace.worktree?.isLinkedWorktree),
    branch && branch !== workspaceBoardLabel(workspace) ? branch : undefined,
  );
}

function worktreeBoardLabel(worktree: WorktreeRecord): string {
  return worktree.branch ?? worktree.label ?? basename(worktree.path);
}

function worktreeLabel(worktree: WorktreeRecord): string {
  const name = worktreeBoardLabel(worktree);
  const repo = worktree.repoRoot ? basename(worktree.repoRoot) : undefined;
  return repo && repo !== name ? `${repo} ▸ ${name}` : name;
}

function worktreeDetail(worktree: WorktreeRecord): string | undefined {
  return joinDetail(checkoutKind(worktree.isLinkedWorktree), worktree.isDetached ? "detached" : undefined);
}

// Herdr's focused flags lag behind live focus, so the source pane id is the
// authoritative current-agent signal; flags only fill gaps when the picker
// runs without pane context.
function isCurrentAgent(agent: AgentRecord, workspace: WorkspaceRecord | undefined, current: CurrentContext): boolean {
  if (current.paneId) return agent.paneId === current.paneId;
  return agent.focused === true || workspace?.focused === true;
}

function isCurrentWorkspace(workspace: WorkspaceRecord | undefined, current: CurrentContext): boolean {
  return workspace?.focused === true || (!!current.workspaceId && workspace?.workspaceId === current.workspaceId);
}

function isCurrentPath(path: string, current: CurrentContext, workspace: WorkspaceRecord | undefined = undefined): boolean {
  return isCurrentWorkspace(workspace, current)
    || (!!current.cwd && isPathWithin(path, current.cwd));
}

function checkoutKind(linked: boolean | undefined): string | undefined {
  return linked === false ? "main checkout" : undefined;
}

function visibleAgentStatus(status: string | undefined): string | undefined {
  return status && status !== "unknown" ? `agent ${status}` : undefined;
}

function joinDetail(...parts: Array<string | undefined>): string | undefined {
  const detail = parts.filter((part): part is string => Boolean(part));
  return detail.length > 0 ? detail.join(" · ") : undefined;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value && value.trim().length > 0 ? value : undefined;
}

// Agents share generic labels like "pi", so lead with their workspace relation
// when Herdr provides one; otherwise use cwd basename as the relation anchor.
function agentWorktreeLabel(agent: AgentRecord, workspace: WorkspaceRecord | undefined): string | undefined {
  if (workspace) return workspaceBoardLabel(workspace);
  return agent.cwd ? basename(agent.cwd) : undefined;
}

function agentRepoKey(agent: AgentRecord, workspace: WorkspaceRecord | undefined): string | undefined {
  if (workspace) return workspaceRepoKey(workspace);
  return agent.cwd ? canonicalPathKey(agent.cwd) : undefined;
}

function agentLabel(agent: AgentRecord, workspace: WorkspaceRecord | undefined): string {
  const where = workspace ? workspaceLabel(workspace) : (agent.cwd ? basename(agent.cwd) : agent.workspaceId);
  return where ? `${where} ▸ ${agent.label}` : agent.label;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function uniqueBy<T>(values: readonly T[], key: (value: T) => string): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const value of values) {
    const itemKey = key(value);
    if (seen.has(itemKey)) continue;
    seen.add(itemKey);
    result.push(value);
  }
  return result;
}