import { Herdr } from "./client/herdr.ts";
import { closePickerSurface } from "./client/popup.ts";
import { createPickerFocusGuard, type PickerFocusGuard } from "./client/picker-focus.ts";
import { PICKER_TOKEN_ENV, PickerSession } from "./picker-session.ts";
import { loadConfig } from "./config/config.ts";
import { runPickerLoop } from "./picker-loop.ts";
import { color, dim } from "./style.ts";
import { boundedTerminalBlock } from "./util/terminal-text.ts";

const EXIT_SIGNALS = ["SIGHUP", "SIGINT", "SIGTERM"] as const;
const COMBINED_FAILURE_MESSAGE = "Picker failed and its popup could not be closed.";

async function main(): Promise<void> {
  const env = process.env;
  const session = new PickerSession(env);
  const lifecycle = new AbortController();
  let exitSignal: (typeof EXIT_SIGNALS)[number] | undefined;
  const handlers = EXIT_SIGNALS.map(signal => ({
    signal,
    handler: () => { exitSignal ??= signal; lifecycle.abort(); },
  }));
  try {
    const token = env[PICKER_TOKEN_ENV];
    // A rejected child has no authority to close any existing surface.
    if (!token || !session.claim(token, env.HERDR_PANE_ID)) throw new Error("Picker reservation is missing or stale.");
    for (const { signal, handler } of handlers) process.on(signal, handler);
    await withPopupClose(async dismissSurface => {
      const config = loadConfig(env);
      // Only the newest mode's guard can record a failure: older guards ignore
      // losses once their mode is aborted, and a failure ends the loop.
      let focusGuard: PickerFocusGuard | undefined;
      const outcome = await runPickerLoop(session, token, {
        env, signal: lifecycle.signal, dismissSurface,
        createRuntime: signal => {
          const guard = createPickerFocusGuard(
            { socketPath: env.HERDR_SOCKET_PATH, paneId: env.HERDR_PANE_ID },
            signal,
            reason => lifecycle.abort(reason),
          );
          focusGuard = guard;
          return {
            herdr: new Herdr({ signal }), config,
            beforeDispatch: () => guard.checkBeforeDispatch(),
            dispose: () => guard.dispose(),
          };
        },
      });
      // Cancellation owns cleanup, but observer failures must still reach the exit boundary.
      if (focusGuard?.failure) throw focusGuard.failure.error;
      if (outcome === "no-agents") {
        console.log(dim(session.latestRequest()?.mode === "repo-agents" ? "No repository agents found." : "No agents found."));
      }
    }, () => closePickerSurface(env));
  } finally {
    lifecycle.abort();
    for (const { signal, handler } of handlers) process.off(signal, handler);
    session.close();
    if (exitSignal) process.kill(process.pid, exitSignal);
  }
}

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

export function formatPaneError(error: unknown): string {
  const rendered = error instanceof AggregateError
    ? [error.message, ...error.errors.map(formatPaneError)].join("\n")
    : error instanceof Error
      ? error.message
      : String(error);
  // Popup output is user-facing: every line is sanitized and the whole
  // aggregate stays bounded so failures cannot flood the terminal.
  return boundedTerminalBlock(rendered);
}

if (import.meta.main) {
  try {
    await main();
    // Overlay close can leave stdin handles; this process is the picker pane.
    process.exit(0);
  } catch (error) {
    console.error(color("red", formatPaneError(error)));
    process.exit(1);
  }
}
