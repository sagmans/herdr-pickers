import { parsePickerSnapshotResponse, type PickerFocusLifecycleMessage } from "./types.ts";

const SNAPSHOT_ARGS = ["api", "snapshot"] as const;
const DEFAULT_HERDR_BIN = "herdr";
const MAX_SNAPSHOT_BYTES = 1024 * 1024;
const SNAPSHOT_FAILURE = "Picker focus snapshot failed";

export async function readPickerSnapshot(socketPath: string, paneId: string, signal: AbortSignal): Promise<PickerFocusLifecycleMessage> {
  signal.throwIfAborted();
  // The native client writes before Herdr enters its 100 ms initial-read poll.
  const proc = Bun.spawn([process.env.HERDR_BIN_PATH ?? DEFAULT_HERDR_BIN, ...SNAPSHOT_ARGS], {
    env: { ...process.env, HERDR_SOCKET_PATH: socketPath },
    signal, stdout: "pipe", stderr: "ignore", stdin: "ignore",
  });
  try {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for await (const chunk of proc.stdout) {
      bytes += chunk.byteLength;
      if (bytes > MAX_SNAPSHOT_BYTES) throw new Error(SNAPSHOT_FAILURE);
      chunks.push(chunk);
    }
    if (await proc.exited !== 0) throw new Error(SNAPSHOT_FAILURE);
    signal.throwIfAborted();
    return parsePickerSnapshotResponse(Buffer.concat(chunks, bytes).toString("utf8"), paneId);
  } finally {
    if (proc.exitCode === null) proc.kill();
    await proc.exited;
  }
}
