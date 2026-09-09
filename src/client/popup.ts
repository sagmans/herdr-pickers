import { createConnection } from "node:net";

const SOCKET_ENV = "HERDR_SOCKET_PATH";
const PANE_ID_ENV = "HERDR_PANE_ID";
const OVERLAY_CLOSE_REQUEST_ID = "herdr-pickers:overlay-close";
const OVERLAY_CLOSE_METHOD = "plugin.pane.close";
const OVERLAY_CLOSE_TIMEOUT_MS = 100;
const NEWLINE_BYTE = 0x0a;

export type SocketWriter = (path: string, payload: string) => Promise<void>;

export async function closePickerSurface(
  env: Record<string, string | undefined> = process.env,
  write: SocketWriter = writeSocket,
): Promise<void> {
  const paneId = env[PANE_ID_ENV];
  if (paneId) {
    await Promise.race([
      closeOverlayPane(paneId, env, write),
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
