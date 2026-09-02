import { isRecord } from "../util/objects.ts";

export interface WorktreeProvenance {
  readonly branch?: string | undefined;
  readonly path?: string | undefined;
  readonly checkoutPath?: string | undefined;
  readonly repoName?: string | undefined;
  readonly repoRoot?: string | undefined;
  readonly repoKey?: string | undefined;
  readonly isLinkedWorktree?: boolean | undefined;
}

export interface WorkspaceRecord {
  readonly workspaceId: string;
  readonly label?: string | undefined;
  readonly cwd?: string | undefined;
  readonly worktree?: WorktreeProvenance | undefined;
  readonly tabCount?: number | undefined;
  readonly paneCount?: number | undefined;
  readonly agentStatus?: string | undefined;
  readonly focused?: boolean | undefined;
}

export interface WorktreeRecord {
  readonly path: string;
  readonly label?: string | undefined;
  readonly branch?: string | undefined;
  readonly repoRoot?: string | undefined;
  readonly isBare: boolean;
  readonly isDetached: boolean;
  readonly isLinkedWorktree: boolean;
  readonly isPrunable: boolean;
  readonly openWorkspaceId?: string | undefined;
}

export interface WorktreeListResult {
  readonly sourceRepoRoot?: string | undefined;
  readonly sourceWorkspaceId?: string | undefined;
  readonly worktrees: readonly WorktreeRecord[];
}

export interface AgentRecord {
  readonly target: string;
  readonly label: string;
  readonly workspaceId?: string | undefined;
  readonly tabId?: string | undefined;
  readonly paneId?: string | undefined;
  readonly status?: string | undefined;
  readonly cwd?: string | undefined;
  readonly focused?: boolean | undefined;
}

export interface AgentListResult {
  readonly agents: readonly AgentRecord[];
  readonly skippedWithoutTarget: number;
  readonly skippedWithoutIdentity: number;
  readonly observedKeys: readonly string[];
}

export function readWorkspaces(envelope: unknown): WorkspaceRecord[] {
  const result = getResult(envelope);
  const rows = getArray(result.workspaces);
  return rows.flatMap(readWorkspace);
}

export function workspaceRepoRoots(workspaces: readonly WorkspaceRecord[]): string[] {
  const roots = new Set<string>();
  for (const workspace of workspaces) {
    const root = workspace.worktree?.repoRoot;
    if (root) roots.add(root);
  }
  return [...roots].sort((left, right) => left.localeCompare(right));
}

export function readWorktrees(envelope: unknown): WorktreeListResult {
  const result = getResult(envelope);
  const source = optionalRecord(result.source);
  return {
    sourceRepoRoot: optionalString(source?.repo_root),
    sourceWorkspaceId: optionalString(source?.source_workspace_id),
    worktrees: getArray(result.worktrees).flatMap(readWorktree),
  };
}

// Agent scoping does not need the full worktree catalog, so retain the narrow
// parser used on its hot refresh path.
export function readWorktreeScope(envelope: unknown): string | undefined {
  const result = getResult(envelope);
  const source = optionalRecord(result.source);
  return optionalString(source?.repo_root);
}

export function readAgentList(envelope: unknown): AgentListResult {
  const result = getResult(envelope);
  const rows = getArray(result.agents).flatMap((value) => {
    const record = optionalRecord(value);
    return record ? [record] : [];
  });
  const nameCounts = countStrings(rows, "name");
  const labelCounts = countStrings(rows, "label");
  const agents: AgentRecord[] = [];
  const observedKeys = new Set<string>();
  let skippedWithoutTarget = 0;
  let skippedWithoutIdentity = 0;

  for (const row of rows) {
    for (const key of Object.keys(row)) observedKeys.add(key);
    if (!hasAgentIdentity(row)) {
      skippedWithoutIdentity += 1;
      continue;
    }
    const agent = readAgent(row, nameCounts, labelCounts);
    if (agent) agents.push(agent);
    else skippedWithoutTarget += 1;
  }

  return { agents, skippedWithoutTarget, skippedWithoutIdentity, observedKeys: [...observedKeys].sort((left, right) => left.localeCompare(right)) };
}

function getResult(envelope: unknown): Record<string, unknown> {
  const record = expectRecord(envelope);
  return expectRecord(record.result);
}

function expectRecord(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value;
  throw new Error("Expected JSON object");
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  return expectRecord(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalBoolean(value: unknown): boolean {
  return optionalBooleanOrUndefined(value) ?? false;
}

function optionalBooleanOrUndefined(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function getArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readWorkspace(value: unknown): WorkspaceRecord[] {
  const record = optionalRecord(value);
  const workspaceId = optionalString(record?.workspace_id) ?? optionalString(record?.id);
  if (!record || !workspaceId) return [];

  const worktree = readWorktreeProvenance(record.worktree);
  return [{
    workspaceId,
    label: optionalString(record.label),
    cwd: optionalString(record.cwd),
    worktree,
    tabCount: optionalNumber(record.tab_count),
    paneCount: optionalNumber(record.pane_count),
    agentStatus: firstString(record, ["agent_status", "status", "state"]),
    focused: optionalBooleanOrUndefined(record.focused),
  }];
}

function readWorktreeProvenance(value: unknown): WorktreeProvenance | undefined {
  const record = optionalRecord(value);
  if (!record) return undefined;
  return {
    branch: optionalString(record.branch),
    path: optionalString(record.path),
    checkoutPath: optionalString(record.checkout_path),
    repoName: optionalString(record.repo_name),
    repoRoot: optionalString(record.repo_root),
    repoKey: optionalString(record.repo_key),
    isLinkedWorktree: optionalBooleanOrUndefined(record.is_linked_worktree),
  };
}

function readWorktree(value: unknown): WorktreeRecord[] {
  const record = optionalRecord(value);
  const path = optionalString(record?.path) ?? optionalString(record?.checkout_path);
  if (!record || !path) return [];

  return [{
    path,
    label: optionalString(record.label),
    branch: optionalString(record.branch),
    repoRoot: optionalString(record.repo_root),
    isBare: optionalBoolean(record.is_bare),
    isDetached: optionalBoolean(record.is_detached),
    isLinkedWorktree: optionalBoolean(record.is_linked_worktree),
    isPrunable: optionalBoolean(record.is_prunable),
    openWorkspaceId: optionalString(record.open_workspace_id),
  }];
}

function readAgent(record: Record<string, unknown>, nameCounts: ReadonlyMap<string, number>, labelCounts: ReadonlyMap<string, number>): AgentRecord | undefined {
  const target = stableAgentTarget(record, nameCounts, labelCounts);
  if (!target) return undefined;

  const sessionAgent = readSessionAgent(record.agent_session);
  return {
    target,
    label: firstString(record, ["label", "name", "agent", "kind"]) ?? sessionAgent ?? target,
    workspaceId: optionalString(record.workspace_id),
    tabId: optionalString(record.tab_id),
    paneId: optionalString(record.pane_id),
    // Herdr reports the live run state under agent_status; keep status/state as
    // fallbacks for other Herdr versions or agent kinds.
    status: firstString(record, ["agent_status", "status", "state"]),
    cwd: firstString(record, ["cwd", "foreground_cwd"]),
    focused: typeof record.focused === "boolean" ? record.focused : undefined,
  };
}

function hasAgentIdentity(record: Record<string, unknown>): boolean {
  return firstString(record, ["label", "name", "agent", "kind"]) !== undefined || readSessionAgent(record.agent_session) !== undefined;
}

function readSessionAgent(value: unknown): string | undefined {
  return isRecord(value) ? optionalString(value.agent) : undefined;
}

// herdr 0.7.5+ resolves agent targets only through public pane ids or unique
// agent names (terminal ids stopped resolving); prefer pane_id so selection
// keeps working across herdr versions that still expose a legacy target field.
function stableAgentTarget(record: Record<string, unknown>, nameCounts: ReadonlyMap<string, number>, labelCounts: ReadonlyMap<string, number>): string | undefined {
  return firstString(record, ["target", "pane_id", "terminal_id"])
    ?? uniqueField(record, "name", nameCounts)
    ?? uniqueField(record, "label", labelCounts);
}

function uniqueField(record: Record<string, unknown>, key: string, counts: ReadonlyMap<string, number>): string | undefined {
  const value = optionalString(record[key]);
  return value && counts.get(value) === 1 ? value : undefined;
}

function countStrings(records: readonly Record<string, unknown>[], key: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const record of records) {
    const value = optionalString(record[key]);
    if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

function firstString(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = optionalString(record[key]);
    if (value) return value;
  }
  return undefined;
}