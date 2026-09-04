import { Herdr } from "./client/herdr.ts";
import { closePickerSurface } from "./client/popup.ts";
import { watchPickerFocus } from "./client/picker-focus.ts";
import { PICKER_TOKEN_ENV, PickerSession } from "./picker-session.ts";
import { loadConfig } from "./config/config.ts";
import { parseMode, runPicker } from "./picker.ts";
import { color, dim } from "./style.ts";
import { boundedTerminalBlock } from "./util/terminal-text.ts";

const MODE_ENV = "HERDR_PICKERS_MODE";
const EXIT_SIGNALS = ["SIGHUP", "SIGINT", "SIGTERM"] as const;
const COMBINED_FAILURE_MESSAGE = "Picker failed and its popup could not be closed.";

async function main(): Promise<void> {
  const env = process.env;
  const session = new PickerSession(env);
  const lifecycle = new AbortController();
  let watch: Awaited<ReturnType<typeof watchPickerFocus>> | undefined;
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
    await withPopupClose(async () => {
      const mode = parseMode(env[MODE_ENV]);
      const config = loadConfig(env);
      if (lifecycle.signal.aborted) return;
      if (env.HERDR_PANE_ID) watch = await watchPickerFocus(env.HERDR_SOCKET_PATH!, env.HERDR_PANE_ID);
      const signal = watch ? AbortSignal.any([lifecycle.signal, watch.signal]) : lifecycle.signal;
      const outcome = await runPicker(mode, {
        herdr: new Herdr({ signal }), env, config, signal, beforeDispatch: () => watch?.stop(),
      });
      if (outcome === "no-agents") {
        console.log(dim(mode === "repo-agents" ? "No repository agents found." : "No agents found."));
      }
    }, () => closePickerSurface(env));
  } finally {
    watch?.stop();
    lifecycle.abort();
    for (const { signal, handler } of handlers) process.off(signal, handler);
    session.close();
    if (exitSignal) process.kill(process.pid, exitSignal);
  }
}

export async function withPopupClose<T>(work: () => Promise<T>, close: () => Promise<void>): Promise<T> {
  let result: T;
  try {
    result = await work();
  } catch (error) {
    try {
      await close();
    } catch (closeError) {
      throw new AggregateError([error, closeError], COMBINED_FAILURE_MESSAGE);
    }
    throw error;
  }
  await close();
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
