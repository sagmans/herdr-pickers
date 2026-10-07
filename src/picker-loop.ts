// Keeps one picker pane serving successive requests. When a newer request
// replaces the current mode, the loop restarts on the same leased terminal so
// the popup never flashes; picker-session.ts supplies the request mailbox.
import { runPicker, type PickerOutcome, type PickerRuntime } from "./picker.ts";
import type { PickerItem } from "./picker-row.ts";
import { PICKER_REQUEST_POLL_MS, type PickerSession } from "./picker-session.ts";
import { withPickerTerminal, type PickerTerminal, type TerminalAdapter } from "./picker-terminal.ts";
import { runTerminalPicker, type TerminalPickerOptions } from "./terminal-picker.ts";

const REPLACED = "Picker request superseded";
const OWNER_LOST = "Picker request ownership could not be verified";

type RequestSession = Pick<PickerSession, "latestRequest" | "acknowledge">;
/** Per-mode runtime; the loop supplies the terminal, so overrides receive a leased one. */
export interface LoopRuntime extends Omit<PickerRuntime, "pickerRunner"> {
  readonly pickerRunner?: ((options: TerminalPickerOptions) => Promise<PickerItem | undefined>) | undefined;
  readonly dispose?: () => void | Promise<void>;
}
interface LoopOptions {
  readonly env: Record<string, string | undefined>;
  readonly signal?: AbortSignal;
  readonly terminal?: TerminalAdapter;
  /** Removes the popup or overlay; runs before terminal restore so no blank screen flashes. */
  readonly dismissSurface?: () => Promise<void>;
  readonly createRuntime: (signal: AbortSignal) => LoopRuntime;
}

/**
 * Serves the newest request owned by `owner` until a mode finishes or the signal aborts.
 * Throws when request ownership cannot be verified; superseded runs restart silently.
 */
export async function runPickerLoop(session: RequestSession, owner: string, options: LoopOptions): Promise<PickerOutcome> {
  return withPickerTerminal(options.terminal, terminal => loop(session, owner, options, terminal), options.dismissSurface);
}

async function loop(session: RequestSession, owner: string, options: LoopOptions, terminal: PickerTerminal): Promise<PickerOutcome> {
  while (!options.signal?.aborted) {
    const request = session.latestRequest();
    if (!request) throw new Error(OWNER_LOST);
    if (!session.acknowledge(request.token, owner)) {
      if (session.latestRequest()?.token !== request.token) continue;
      throw new Error(OWNER_LOST);
    }
    const current = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, current.signal]) : current.signal;
    let dispatching = false;
    let fault: { error: unknown } | undefined;
    const checkRequest = () => {
      if (!dispatching && session.latestRequest()?.token !== request.token) current.abort(new Error(REPLACED));
    };
    const timer = setInterval(() => {
      try { checkRequest(); } catch (error) { fault = { error }; current.abort(error); }
    }, PICKER_REQUEST_POLL_MS);
    let runtime: LoopRuntime | undefined;
    let outcome: PickerOutcome;
    try {
      runtime = options.createRuntime(signal);
      const runner = runtime.pickerRunner ?? runTerminalPicker;
      const confirmFocus = runtime.beforeDispatch;
      outcome = await runPicker(request.mode, {
        ...runtime,
        env: options.env,
        context: request.context,
        signal,
        pickerRunner: picker => runner({ ...picker, terminal: terminal.lease(picker.signal ?? signal) }),
        beforeDispatch: async () => {
          checkRequest();
          signal.throwIfAborted();
          await confirmFocus?.();
          checkRequest();
          signal.throwIfAborted();
          // Once a command is submitted, a later action must wait for a successor surface.
          dispatching = true;
        },
      });
    } catch (error) {
      // A superseded operation can fail before the next mailbox tick observes replacement.
      if (dispatching || session.latestRequest()?.token === request.token) throw error;
      outcome = "cancelled";
    } finally {
      clearInterval(timer);
      current.abort();
      await runtime?.dispose?.();
    }
    if (fault) throw fault.error;
    if (options.signal?.aborted) return "cancelled";
    if (!dispatching && session.latestRequest()?.token !== request.token) continue;
    return outcome;
  }
  return "cancelled";
}
