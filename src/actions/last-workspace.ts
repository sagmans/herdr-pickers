import { Herdr } from "../client/herdr.ts";
import { readWorkspaces, type WorkspaceRecord } from "../client/types.ts";
import {
  applyClosed,
  applyFocused,
  containsWorkspace,
  focusedWorkspaceId,
  resolveClosedJump,
  resolveToggle,
} from "../last-workspace/memory.ts";
import { StateStore } from "../last-workspace/store.ts";
import { isRecord } from "../util/objects.ts";
import { boundedTerminalText } from "../util/terminal-text.ts";

type Subcommand = "toggle" | "focused" | "closed";

const EVENT_JSON_ENV = "HERDR_PLUGIN_EVENT_JSON";
const CONTEXT_JSON_ENV = "HERDR_PLUGIN_CONTEXT_JSON";
const STATE_DIR_ENV = "HERDR_PLUGIN_STATE_DIR";

export interface LastWorkspaceRuntime {
  readonly env: Record<string, string | undefined>;
  readonly herdr: Herdr;
  readonly store: StateStore;
}

export async function runLastWorkspace(subcommand: Subcommand, runtime: LastWorkspaceRuntime): Promise<void> {
  switch (subcommand) {
    case "toggle":
      return runToggle(runtime);
    case "focused":
      return runFocused(runtime);
    case "closed":
      return runClosed(runtime);
    default: {
      const exhaustive: never = subcommand;
      throw new Error(`Unsupported last-workspace subcommand: ${String(exhaustive)}`);
    }
  }
}

async function runToggle(runtime: LastWorkspaceRuntime): Promise<void> {
  const workspaces = await listWorkspaces(runtime.herdr);
  const currentId = focusedWorkspaceId(workspaces) ?? contextWorkspaceId(runtime.env, workspaces);
  const target = runtime.store.update((memory) => {
    const result = resolveToggle(memory, currentId, (id) => containsWorkspace(workspaces, id));
    return { memory: result.memory, value: result.target };
  });
  if (target) await runtime.herdr.run(["workspace", "focus", target]);
}

async function runFocused(runtime: LastWorkspaceRuntime): Promise<void> {
  const eventId = eventWorkspaceId(runtime.env);
  if (!eventId) return;
  const workspaces = await listWorkspaces(runtime.herdr);
  // Live focus rejects delayed event handlers that would reverse history.
  if (focusedWorkspaceId(workspaces) !== eventId) return;
  runtime.store.update((memory) => ({ memory: applyFocused(memory, eventId, eventId), value: undefined }));
}

async function runClosed(runtime: LastWorkspaceRuntime): Promise<void> {
  const closedId = eventWorkspaceId(runtime.env);
  if (!closedId) return;
  const workspaces = await listWorkspaces(runtime.herdr);
  const liveFocus = focusedWorkspaceId(workspaces);
  const target = runtime.store.update((memory) => {
    const jumpTarget = resolveClosedJump(
      memory,
      closedId,
      liveFocus,
      (id) => containsWorkspace(workspaces, id),
    );
    return {
      memory: applyClosed(memory, closedId, liveFocus),
      value: jumpTarget,
    };
  });
  if (!target) return;
  try {
    await runtime.herdr.run(["workspace", "focus", target]);
    // Rewriting memory prevents trailing focus events for the neighbor from registering the closed workspace as previous.
    runtime.store.update(() => ({
      memory: { kind: "current", current: target, last: undefined },
      value: undefined,
    }));
  } catch (error) {
    // Event hooks must not fail the workspace close flow when navigation fails.
    // Report one sanitized line: passing the Error object would let Bun print
    // its stack with source paths into the event log.
    console.error(formatEventFailure("failed to focus previous workspace on close", error));
  }
}

async function listWorkspaces(herdr: Herdr): Promise<WorkspaceRecord[]> {
  return readWorkspaces(await herdr.json(["workspace", "list"]));
}

function eventWorkspaceId(env: Record<string, string | undefined>): string | undefined {
  const raw = env[EVENT_JSON_ENV];
  return jsonStringField(raw, ["data", "workspace_id"]) ?? jsonStringField(raw, ["workspace_id"]);
}

function contextWorkspaceId(
  env: Record<string, string | undefined>,
  workspaces: readonly WorkspaceRecord[],
): string | undefined {
  const id = jsonStringField(env[CONTEXT_JSON_ENV], ["workspace_id"]);
  return id && containsWorkspace(workspaces, id) ? id : undefined;
}

function jsonStringField(raw: string | undefined, path: readonly string[]): string | undefined {
  if (!raw) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  let current: unknown = value;
  for (const segment of path) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return typeof current === "string" && current.trim().length > 0 ? current : undefined;
}

export function parseSubcommand(value: string | undefined): Subcommand {
  switch (value) {
    case "toggle":
    case "focused":
    case "closed":
      return value;
    default:
      throw new Error(`Unknown last-workspace subcommand '${value ?? ""}'. Usage: last-workspace <toggle|focused|closed>`);
  }
}

// One bounded, sanitized, stack-free line for event-hook failures.
export function formatEventFailure(reason: string, error: unknown): string {
  const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
  return boundedTerminalText(`${reason}: ${message}`);
}

if (import.meta.main) {
  const stateDir = process.env[STATE_DIR_ENV];
  if (!stateDir) {
    console.error("HERDR_PLUGIN_STATE_DIR is required; run via the herdr-pickers action or event hook.");
    process.exit(1);
  }
  const subcommand = parseSubcommand(process.argv[2]);
  const runtime: LastWorkspaceRuntime = {
    env: process.env,
    herdr: new Herdr(),
    store: new StateStore({ stateDir }),
  };
  runLastWorkspace(subcommand, runtime).catch((error: unknown) => {
    console.error(formatEventFailure("last-workspace failed", error));
    process.exit(1);
  });
}
