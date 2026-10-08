// The pane's per-mode focus contract: focus departure cancels the picker, and
// dispatch waits for Herdr to reconfirm that the picker still holds focus.
// Observer breakage travels as a typed abort reason so the pane can report it
// after the loop has finished its cleanup.
import { PickerFocusDeparture, watchPickerFocus } from "./client/picker-focus.ts";
import type { PickerSurface } from "./client/popup.ts";

const SOCKET_REQUIRED_MESSAGE = "HERDR_SOCKET_PATH is required to observe overlay picker focus.";
const WATCH_FAILURE_MESSAGE = "Picker focus observation failed";

/** Observer breakage, as opposed to departure, which is ordinary cancellation. */
export class PickerFocusFailure extends Error {
  constructor(readonly cause: unknown) {
    super(WATCH_FAILURE_MESSAGE);
    this.name = "PickerFocusFailure";
  }
}

/** Where a guard observes focus; a popup has no pane of its own to watch. */
export interface PickerFocusTarget {
  readonly socketPath: string | undefined;
  readonly surface: PickerSurface;
}

/**
 * One mode's focus contract. `onLost` receives a PickerFocusFailure for
 * breakage, or the PickerFocusDeparture that the pane treats as cancellation.
 */
export interface PickerFocusGuard {
  checkBeforeDispatch(): Promise<void>;
  dispose(): Promise<void>;
}

/**
 * Builds a fresh guard per mode because accepting a selection stops its
 * observer. `onLost` aborts the picker; only losses while the mode is live count.
 */
export function createPickerFocusGuard(
  target: PickerFocusTarget,
  signal: AbortSignal,
  onLost: (reason: unknown) => void,
): PickerFocusGuard {
  const { socketPath, surface } = target;
  let watch: Awaited<ReturnType<typeof watchPickerFocus>> | undefined;
  const lose = (error: unknown): void => {
    if (signal.aborted) return;
    onLost(error instanceof PickerFocusDeparture ? error : new PickerFocusFailure(error));
  };
  const ready = surface.placement === "popup"
    ? undefined
    : (socketPath === undefined
      ? Promise.reject(new Error(SOCKET_REQUIRED_MESSAGE))
      : watchPickerFocus(socketPath, surface.paneId, signal)
    ).then(watcher => {
      watch = watcher;
      watcher.signal.addEventListener("abort", () => lose(watcher.signal.reason), { once: true });
      if (watcher.signal.aborted) lose(watcher.signal.reason);
    }).catch(lose);
  return {
    async checkBeforeDispatch() {
      await ready;
      signal.throwIfAborted();
      await watch?.prepareDispatch();
    },
    async dispose() {
      // Stop an established observer immediately; setup still in flight settles
      // on the aborted mode signal and may yield a watcher that needs stopping too.
      watch?.stop();
      await ready;
      watch?.stop();
    },
  };
}
