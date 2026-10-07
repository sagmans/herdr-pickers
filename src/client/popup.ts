import { createConnection } from "node:net";

const SOCKET_ENV = "HERDR_SOCKET_PATH";
const PANE_ID_ENV = "HERDR_PANE_ID";
const OVERLAY_CLOSE_REQUEST_ID = "herdr-pickers:overlay-close";
const OVERLAY_CLOSE_METHOD = "plugin.pane.close";
const OVERLAY_CLOSE_TIMEOUT_MS = 100;
const NEWLINE_BYTE = 0x0a;
const COMBINED_FAILURE_MESSAGE = "Picker failed and its popup could not be closed.";

/**
 * Where a picker child draws. Herdr gives a plugin pane child HERDR_PANE_ID only
 * when it runs as an overlay pane; a native popup has no pane of its own. This
 * is the one place that inference is made so claim, focus, and close agree.
 */
export type PickerSurface =
  | { readonly placement: "overlay"; readonly paneId: string }
  | { readonly placement: "popup" };

export const POPUP_SURFACE: PickerSurface = { placement: "popup" };

export function pickerSurfaceFromEnv(env: Record<string, string | undefined>): PickerSurface {
  const paneId = env[PANE_ID_ENV];
  return paneId ? { placement: "overlay", paneId } : POPUP_SURFACE;
}

export type SocketWriter = (path: string, payload: string) => Promise<void>;

export async function closePickerSurface(
  env: Record<string, string | undefined> = process.env,
  write: SocketWriter = writeSocket,
): Promise<void> {
  const surface = pickerSurfaceFromEnv(env);
  if (surface.placement === "overlay") {
    await Promise.race([
      closeOverlayPane(surface.paneId, env, write),
      delay(OVERLAY_CLOSE_TIMEOUT_MS),
    ]);
    return;
  }
  // Native exit removes this popup; an unqualified close could dismiss its successor.
}

export async function closeOverlayPane(
  paneId: string,
  env: Record<string, string | undefined> = process.env,
  write: SocketWriter = writeSocket,
): Promise<void> {
  const path = env[SOCKET_ENV];
  if (!path) throw new Error(`${SOCKET_ENV} is required to close the picker overlay.`);
  const payload = `${JSON.stringify({
    id: OVERLAY_CLOSE_REQUEST_ID,
    method: OVERLAY_CLOSE_METHOD,
    params: { pane_id: paneId },
  })}\n`;
  await write(path, payload);
}

/**
 * Guarantees exactly one surface close around picker work. Work may dismiss
 * early (before terminal restore); a close failure never masks a picker error.
 */
export async function withPopupClose<T>(work: (dismissSurface: () => Promise<void>) => Promise<T>, close: () => Promise<void>): Promise<T> {
  let closing: Promise<void> | undefined;
  const closeOnce = () => closing ??= Promise.resolve().then(close);
  const dismissSurface = async (): Promise<void> => {
    // Report close errors outside terminal cleanup so the original picker error survives.
    try { await closeOnce(); } catch {}
  };
  let result: T;
  try {
    result = await work(dismissSurface);
  } catch (error) {
    try {
      await closeOnce();
    } catch (closeError) {
      throw new AggregateError([error, closeError], COMBINED_FAILURE_MESSAGE);
    }
    throw error;
  }
  await closeOnce();
  return result;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function writeSocket(path: string, payload: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection(path);
    socket.unref();
    const finish = (error?: Error): void => {
      clearTimeout(timeout);
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    const timeout = setTimeout(finish, OVERLAY_CLOSE_TIMEOUT_MS);
    socket.once("error", () => finish(new Error("failed to close the picker popup")));
    // A flushed request is not a removed pane; retain its frame until Herdr replies.
    socket.on("data", (chunk: Buffer) => {
      if (chunk.includes(NEWLINE_BYTE)) finish();
    });
    socket.once("end", () => finish());
    socket.once("connect", () => { socket.write(payload); });
  });
}
