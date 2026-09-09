import { CURRENT_CONTEXT_ENV, type CurrentContext } from "./catalog.ts";
import { runPicker, type PickerOutcome, type PickerRuntime } from "./picker.ts";
import { PICKER_REQUEST_POLL_MS } from "./picker-request.ts";
import type { PickerSession } from "./picker-session.ts";
import { PickerTerminal } from "./picker-terminal.ts";
import { runTerminalPicker, type TerminalAdapter } from "./terminal-picker.ts";

const REPLACED = "Picker request superseded";
const OWNER_LOST = "Picker request ownership could not be verified";

type RequestSession = Pick<PickerSession, "latestRequest" | "acknowledge">;
export interface LoopRuntime extends PickerRuntime {
  readonly dispose?: () => void | Promise<void>;
}
interface LoopOptions {
  readonly env: Record<string, string | undefined>;
  readonly signal?: AbortSignal;
  readonly terminal?: TerminalAdapter;
  readonly beforeCleanup?: () => Promise<void>;
  readonly createRuntime: (signal: AbortSignal) => LoopRuntime;
}

export async function runPickerLoop(session: RequestSession, owner: string, options: LoopOptions): Promise<PickerOutcome> {
  const terminal = new PickerTerminal(options.terminal);
  try {
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
          env: sourceEnvironment(options.env, request.context),
          signal,
          beforeCleanup: undefined,
          pickerRunner: picker => runner({ ...picker, ...terminal.options(signal) }),
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
  } finally {
    try { await options.beforeCleanup?.(); } finally { terminal.close(); }
  }
}

function sourceEnvironment(env: Record<string, string | undefined>, context: CurrentContext): Record<string, string | undefined> {
  return {
    ...env,
    HERDR_WORKSPACE_ID: context.workspaceId,
    HERDR_TAB_ID: context.tabId,
    HERDR_PANE_ID: context.paneId,
    HERDR_ACTIVE_WORKSPACE_ID: context.workspaceId,
    HERDR_ACTIVE_PANE_CWD: context.cwd,
    PWD: context.cwd,
    ...Object.fromEntries(Object.entries(CURRENT_CONTEXT_ENV).map(([key, name]) => [name, context[key as keyof CurrentContext]])),
  };
}
