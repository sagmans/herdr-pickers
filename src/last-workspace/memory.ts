import type { WorkspaceRecord } from "../client/types.ts";
import { isRecord } from "../util/objects.ts";

export type WorkspaceMemory =
  | { readonly kind: "empty" }
  | { readonly kind: "current"; readonly current: string; readonly last: string | undefined };

export const EMPTY_MEMORY: WorkspaceMemory = { kind: "empty" };

export interface PersistedState {
  current_workspace_id?: string;
  last_workspace_id?: string;
  updated_unix_ms?: number;
}

export function focusedWorkspaceId(workspaces: readonly WorkspaceRecord[]): string | undefined {
  return workspaces.find((workspace) => workspace.focused === true)?.workspaceId;
}

export function containsWorkspace(workspaces: readonly WorkspaceRecord[], id: string): boolean {
  return workspaces.some((workspace) => workspace.workspaceId === id);
}

export function fromPersisted(state: PersistedState | undefined): WorkspaceMemory {
  if (!state) return EMPTY_MEMORY;
  const current = nonEmpty(state.current_workspace_id);
  const last = nonEmpty(state.last_workspace_id);
  if (!current) return EMPTY_MEMORY;
  // Equal slots cannot produce navigation, so discard duplicate persisted data.
  return { kind: "current", current, last: last && last !== current ? last : undefined };
}

export function toPersisted(memory: WorkspaceMemory, now: number): PersistedState {
  if (memory.kind === "empty") return { updated_unix_ms: now };
  const state: PersistedState = { current_workspace_id: memory.current, updated_unix_ms: now };
  if (memory.last !== undefined) state.last_workspace_id = memory.last;
  return state;
}

export function parsePersistedState(value: unknown): PersistedState | undefined {
  if (!isRecord(value)) return undefined;
  const state: PersistedState = {};
  const current = nonEmpty(typeof value.current_workspace_id === "string" ? value.current_workspace_id : undefined);
  if (current !== undefined) state.current_workspace_id = current;
  const last = nonEmpty(typeof value.last_workspace_id === "string" ? value.last_workspace_id : undefined);
  if (last !== undefined) state.last_workspace_id = last;
  if (typeof value.updated_unix_ms === "number" && Number.isFinite(value.updated_unix_ms)) {
    state.updated_unix_ms = value.updated_unix_ms;
  }
  return state;
}

export function applyFocused(
  memory: WorkspaceMemory,
  eventId: string,
  snapshotFocusedId: string | undefined,
): WorkspaceMemory {
  // Delayed events must not overwrite a newer live focus transition.
  if (snapshotFocusedId !== eventId) return memory;
  if (memory.kind === "empty") return { kind: "current", current: eventId, last: undefined };
  if (memory.current === eventId) return memory;
  return { kind: "current", current: eventId, last: memory.current };
}

export function applyClosed(
  memory: WorkspaceMemory,
  closedId: string,
  snapshotFocusedId: string | undefined,
): WorkspaceMemory {
  if (memory.kind === "empty") return memory;
  if (memory.current !== closedId) {
    if (memory.last === undefined || memory.last !== closedId) return memory;
    return { kind: "current", current: memory.current, last: undefined };
  }
  const current = snapshotFocusedId;
  if (!current) return EMPTY_MEMORY;
  const last = memory.last !== undefined && memory.last !== current ? memory.last : undefined;
  return { kind: "current", current, last };
}

export interface ToggleResult {
  readonly memory: WorkspaceMemory;
  readonly target: string | undefined;
}

export function resolveToggle(
  memory: WorkspaceMemory,
  currentId: string | undefined,
  exists: (id: string) => boolean,
): ToggleResult {
  if (!currentId) return { memory, target: undefined };
  if (memory.kind === "empty") {
    return { memory: { kind: "current", current: currentId, last: undefined }, target: undefined };
  }
  const last = memory.last;
  if (last !== undefined && exists(last) && last !== currentId) {
    // Live focus repairs missed events while preserving a valid toggle target.
    const nextMemory = memory.current === currentId
      ? memory
      : { kind: "current" as const, current: currentId, last };
    return { memory: nextMemory, target: last };
  }
  if (memory.current === currentId && memory.last === undefined) return { memory, target: undefined };
  return { memory: { kind: "current", current: currentId, last: undefined }, target: undefined };
}

export function resolveClosedJump(
  memory: WorkspaceMemory,
  closedId: string,
  snapshotFocusedId: string | undefined,
  exists: (id: string) => boolean,
): string | undefined {
  // Non-focused workspace closes keep default sidebar neighbor landing.
  if (memory.kind === "empty" || memory.current !== closedId) return undefined;
  const closed = applyClosed(memory, closedId, snapshotFocusedId);
  // No recorded target survives when memory becomes empty or previous equals current landing.
  if (closed.kind === "empty" || closed.last === undefined) return undefined;
  // A destroyed previous workspace cannot receive focus.
  return exists(closed.last) ? closed.last : undefined;
}

export function nonEmpty(value: string | undefined): string | undefined {
  return value && value.trim().length > 0 ? value : undefined;
}
