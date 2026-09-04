import { createConnection } from "node:net";

const SOCKET_ENV = "HERDR_SOCKET_PATH";
const REQUEST_ID = "herdr-pickers:popup-close";
const REQUEST_METHOD = "popup.close";

export type SocketWriter = (path: string, payload: string) => Promise<void>;

export async function closePopup(
  env: Record<string, string | undefined> = process.env,
  write: SocketWriter = writeSocket,
): Promise<void> {
  const path = env[SOCKET_ENV];
  if (!path) throw new Error(`${SOCKET_ENV} is required to close the picker popup.`);
  const payload = `${JSON.stringify({ id: REQUEST_ID, method: REQUEST_METHOD, params: {} })}\n`;
  await write(path, payload);
}

export async function closePickerSurface(
  env: Record<string, string | undefined> = process.env,
  write: SocketWriter = writeSocket,
): Promise<void> {
  // Overlay is a real pane: process exit restores zoom. popup.close is popup-only.
  if (env.HERDR_PANE_ID) return;
  await closePopup(env, write);
}

async function writeSocket(path: string, payload: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection(path);
    // Socket errors embed the local socket path; the user-facing message stays generic.
    socket.once("error", () => reject(new Error("failed to close the picker popup")));
    socket.once("connect", () => {
      socket.end(payload, () => {
        socket.destroy();
        resolve();
      });
    });
  });
}
