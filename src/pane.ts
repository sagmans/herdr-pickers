import { Herdr } from "./client/herdr.ts";
import { closePickerSurface } from "./client/popup.ts";
import { watchPickerFocus } from "./client/picker-focus.ts";
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
    await withPopupClose(async beforeCleanup => {
      const config = loadConfig(env);
      const outcome = await runPickerLoop(session, token, {
        env, signal: lifecycle.signal, beforeCleanup,
        createRuntime: signal => {
          let watch: Awaited<ReturnType<typeof watchPickerFocus>> | undefined;
          // Every mode needs a fresh observer because acceptance stops its previous observer.
          const focusReady = env.HERDR_PANE_ID
            ? watchPickerFocus(env.HERDR_SOCKET_PATH!, env.HERDR_PANE_ID, signal).then(watcher => {
              watch = watcher;
              const cancel = () => { if (!signal.aborted) lifecycle.abort(watcher.signal.reason); };
              watcher.signal.addEventListener("abort", cancel, { once: true });
              if (watcher.signal.aborted) cancel();
            }).catch(error => { if (!signal.aborted) lifecycle.abort(error); })
            : undefined;
          return {
            herdr: new Herdr({ signal }), config,
            beforeDispatch: async () => {
              await focusReady;
              signal.throwIfAborted();
              await watch?.prepareDispatch();
            },
            dispose: async () => { watch?.stop(); await focusReady; watch?.stop(); },
          };
        },
      });
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

export async function withPopupClose<T>(work: (beforeCleanup: () => Promise<void>) => Promise<T>, close: () => Promise<void>): Promise<T> {
  let closing: Promise<void> | undefined;
  const closeOnce = () => closing ??= Promise.resolve().then(close);
  const beforeCleanup = async (): Promise<void> => {
    // Report close errors outside terminal cleanup so the original picker error survives.
    try { await closeOnce(); } catch {}
  };
  let result: T;
  try {
    result = await work(beforeCleanup);
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
