import { decodeContext, encodeContext, type CurrentContext } from "./context.ts";
import { parseMode, type PickerMode } from "./modes.ts";
import { isRecord } from "./util/objects.ts";

const INVALID_REQUEST = "Invalid picker replacement request";

export interface PickerRequest {
  readonly token: string;
  readonly mode: PickerMode;
  readonly context: CurrentContext;
  readonly acknowledgedBy: string | null;
}

export function encodeRequestContext(context: CurrentContext): string {
  const encoded = encodeContext(context);
  if (encoded === undefined) throw new Error(INVALID_REQUEST);
  return encoded;
}

export function readPickerRequest(value: unknown): PickerRequest {
  if (!isRecord(value) || typeof value.token !== "string" || !value.token
    || typeof value.mode !== "string" || typeof value.context !== "string"
    || (value.acknowledged !== null && typeof value.acknowledged !== "string")) {
    throw new Error(INVALID_REQUEST);
  }
  const context = decodeContext(value.context);
  if (!context) throw new Error(INVALID_REQUEST);
  return { token: value.token, mode: parseMode(value.mode), context, acknowledgedBy: value.acknowledged };
}
