/**
 * Source context: the Herdr workspace, tab, pane, and cwd an action was
 * invoked from. Pickers mark and scope rows against it, so it must survive the
 * hop from the action process to the long-lived picker pane intact.
 *
 * The action reads it once from Herdr's environment and persists it with the
 * picker request; the picker pane decodes it and threads it as a typed value.
 * Both directions share one field list so a new field cannot be dropped on
 * one side only.
 */
import { isRecord } from "./util/objects.ts";

export interface CurrentContext {
  readonly workspaceId?: string | undefined;
  readonly tabId?: string | undefined;
  readonly paneId?: string | undefined;
  readonly cwd?: string | undefined;
}

// Persisted fields are an allow-list so unrelated values never reach storage.
const CONTEXT_FIELDS = ["workspaceId", "tabId", "paneId", "cwd"] as const satisfies readonly (keyof CurrentContext)[];
// Bounds the stored request so a hostile cwd cannot bloat the session database.
const MAX_CONTEXT_BYTES = 32 * 1024;

const HERDR_CONTEXT_ENV = {
  workspaceId: "HERDR_WORKSPACE_ID",
  tabId: "HERDR_TAB_ID",
  paneId: "HERDR_PANE_ID",
  activeWorkspaceId: "HERDR_ACTIVE_WORKSPACE_ID",
  activePaneCwd: "HERDR_ACTIVE_PANE_CWD",
  shellCwd: "PWD",
} as const;

/** Reads the invoking surface from the environment Herdr gives plugin actions. */
export function currentContextFromEnv(env: Record<string, string | undefined> | undefined): CurrentContext {
  return {
    workspaceId: nonEmpty(env?.[HERDR_CONTEXT_ENV.workspaceId]) ?? nonEmpty(env?.[HERDR_CONTEXT_ENV.activeWorkspaceId]),
    tabId: nonEmpty(env?.[HERDR_CONTEXT_ENV.tabId]),
    paneId: nonEmpty(env?.[HERDR_CONTEXT_ENV.paneId]),
    cwd: nonEmpty(env?.[HERDR_CONTEXT_ENV.activePaneCwd]) ?? nonEmpty(env?.[HERDR_CONTEXT_ENV.shellCwd]),
  };
}

/** Serializes context for the picker request; undefined means it is not storable. */
export function encodeContext(context: CurrentContext): string | undefined {
  const fields = pickContextFields(context);
  if (!fields) return undefined;
  const encoded = JSON.stringify(fields);
  return Buffer.byteLength(encoded) > MAX_CONTEXT_BYTES ? undefined : encoded;
}

/**
 * Parses stored context as untrusted input; undefined means it is malformed,
 * including invalid JSON, so callers report one request error for every shape.
 */
export function decodeContext(encoded: string): CurrentContext | undefined {
  if (Buffer.byteLength(encoded) > MAX_CONTEXT_BYTES) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(encoded);
  } catch {
    return undefined;
  }
  return isRecord(value) ? pickContextFields(value) : undefined;
}

type ContextField = (typeof CONTEXT_FIELDS)[number];

function pickContextFields(source: { readonly [K in ContextField]?: unknown }): CurrentContext | undefined {
  const picked: { [K in ContextField]?: string } = {};
  for (const key of CONTEXT_FIELDS) {
    const value = source[key];
    if (value === undefined) continue;
    if (typeof value !== "string") return undefined;
    picked[key] = value;
  }
  return picked;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value && value.trim().length > 0 ? value : undefined;
}
