// One-shot focus snapshot via a separate `herdr api snapshot` client, so the
// event subscription socket in ./picker-focus.ts never multiplexes requests.
import { runArgv } from "../util/subprocess.ts";
import { herdrBinary } from "./herdr.ts";
import { parsePickerSnapshotResponse, type PickerFocusLifecycleMessage } from "./types.ts";

const SNAPSHOT_ARGS = ["api", "snapshot"] as const;
const MAX_SNAPSHOT_BYTES = 1024 * 1024;
const SNAPSHOT_FAILURE = "Picker focus snapshot failed";

/** Current focus for `paneId` on the given socket; any Herdr failure or oversized output rejects. */
export async function readPickerSnapshot(socketPath: string, paneId: string, signal: AbortSignal): Promise<PickerFocusLifecycleMessage> {
  // The native client writes before Herdr enters its 100 ms initial-read poll.
  const result = await runArgv([herdrBinary(), ...SNAPSHOT_ARGS], {
    signal,
    env: { ...process.env, HERDR_SOCKET_PATH: socketPath },
    stdoutLimit: { bytes: MAX_SNAPSHOT_BYTES, error: () => new Error(SNAPSHOT_FAILURE) },
  });
  if (result.exitCode !== 0) throw new Error(SNAPSHOT_FAILURE);
  return parsePickerSnapshotResponse(result.stdout, paneId);
}
