import type { CurrentContext } from "./catalog.ts";
import { parseMode, type PickerMode } from "./picker.ts";
import { isRecord } from "./util/objects.ts";

export const PICKER_REQUEST_POLL_MS = 25;
export const PICKER_REQUEST_TIMEOUT_MS = 3_000;
const MAX_CONTEXT_BYTES = 32 * 1024;
const CONTEXT_FIELDS = ["workspaceId", "tabId", "paneId", "cwd"] as const;
const INVALID_REQUEST = "Invalid picker replacement request";

export interface PickerRequest {
  readonly token: string;
  readonly mode: PickerMode;
  readonly context: CurrentContext;
  readonly acknowledgedBy: string | null;
}

export function encodeRequestContext(context: CurrentContext): string {
  const encoded = JSON.stringify(Object.fromEntries(CONTEXT_FIELDS.flatMap(key => {
    const value = context[key];
    if (value === undefined) return [];
    if (typeof value !== "string") throw new Error(INVALID_REQUEST);
    return [[key, value]];
  })));
  if (Buffer.byteLength(encoded) > MAX_CONTEXT_BYTES) throw new Error(INVALID_REQUEST);
  return encoded;
}

export function readPickerRequest(value: unknown): PickerRequest {
  if (!isRecord(value) || typeof value.token !== "string" || !value.token
    || typeof value.mode !== "string" || typeof value.context !== "string"
    || Buffer.byteLength(value.context) > MAX_CONTEXT_BYTES
    || (value.acknowledged !== null && typeof value.acknowledged !== "string")) {
    throw new Error(INVALID_REQUEST);
  }
  const context: unknown = JSON.parse(value.context);
  if (!isRecord(context)) throw new Error(INVALID_REQUEST);
  const checked: CurrentContext = Object.fromEntries(CONTEXT_FIELDS.flatMap(key => {
    const field = context[key];
    if (field === undefined) return [];
    if (typeof field !== "string") throw new Error(INVALID_REQUEST);
    return [[key, field]];
  }));
  return { token: value.token, mode: parseMode(value.mode), context: checked, acknowledgedBy: value.acknowledged };
}
