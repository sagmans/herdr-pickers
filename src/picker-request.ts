// Wire format for picker requests stored in the session database. Rows are
// untrusted input, so every field is validated before it selects behavior.
import { decodeContext, encodeContext, type CurrentContext } from "./context.ts";
import { parseMode, type PickerMode } from "./modes.ts";
import { isRecord } from "./util/objects.ts";

const INVALID_REQUEST = "Invalid picker replacement request";

/** Latest action request; `acknowledgedBy` is the claiming picker token, null until one takes it. */
export interface PickerRequest {
  readonly token: string;
  readonly mode: PickerMode;
  readonly context: CurrentContext;
  readonly acknowledgedBy: string | null;
}

/** Throws instead of storing a context that the picker side could not decode. */
export function encodeRequestContext(context: CurrentContext): string {
  const encoded = encodeContext(context);
  if (encoded === undefined) throw new Error(INVALID_REQUEST);
  return encoded;
}

/** Validates a raw database row; throws on any malformed field or unknown mode. */
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
