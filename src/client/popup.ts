// Picker surface lifecycle: decides popup versus overlay from the Herdr env and
// closes an inferred surface. Shared by the pane entrypoint, the session claim,
// and focus observation so they agree on placement and close exactly once.
import { createConnection } from "node:net";

const SOCKET_ENV = "HERDR_SOCKET_PATH";
const PANE_ID_ENV = "HERDR_PANE_ID";
const OVERLAY_CLOSE_REQUEST_ID = "herdr-pickers:overlay-close";
const OVERLAY_CLOSE_METHOD = "plugin.pane.close";
const OVERLAY_CLOSE_TIMEOUT_MS = 100;
const NEWLINE_BYTE = 0x0a;

/**
 * Where a picker child draws. Herdr gives a plugin pane child HERDR_PANE_ID only
 * when it runs as an overlay pane; a native popup has no pane of its own. This
 * is the one place that inference is made so claim, focus, and close agree.
 */
export type PickerSurface =
  | { readonly placement: "overlay"; readonly paneId: string }
  | { readonly placement: "popup" };

/** Shared popup value; a popup carries no pane id to target. */
export const POPUP_SURFACE: PickerSurface = { placement: "popup" };

/** Single inference point for placement; see PickerSurface for the HERDR_PANE_ID contract. */
export function pickerSurfaceFromEnv(env: Record<string, string | undefined>): PickerSurface {
  const paneId = env[PANE_ID_ENV];
  return paneId ? { placement: "overlay", paneId } : POPUP_SURFACE;
}

/** Socket transport seam so close requests can be exercised without a live Herdr. */
export type SocketWriter = (path: string, payload: string) => Promise<void>;

/**
 * Closes an overlay best effort within a short bound so exit is never blocked;
 * popups are left to Herdr, which removes them when the child exits.
 */
export async function closePickerSurface(
  surface: PickerSurface,
  socketPath: string | undefined,
  write: SocketWriter = writeSocket,
): Promise<void> {
  if (surface.placement === "overlay") {
    await Promise.race([
      closeOverlayPane(surface.paneId, socketPath, write),
      delay(OVERLAY_CLOSE_TIMEOUT_MS),
    ]);
  }
  // Native exit removes a popup; an unqualified close could dismiss its successor.
}

/** Asks Herdr to close one overlay pane by id; throws when no socket is available. */
export async function closeOverlayPane(
  paneId: string,
  socketPath: string | undefined,
  write: SocketWriter = writeSocket,
): Promise<void> {
  if (!socketPath) throw new Error(`${SOCKET_ENV} is required to close the picker overlay.`);
  const payload = `${JSON.stringify({
    id: OVERLAY_CLOSE_REQUEST_ID,
    method: OVERLAY_CLOSE_METHOD,
    params: { pane_id: paneId },
  })}\n`;
  await write(socketPath, payload);
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
