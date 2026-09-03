import { Herdr } from "./client/herdr.ts";
import { closePopup } from "./client/popup.ts";
import { loadConfig } from "./config/config.ts";
import { parseMode, runPicker } from "./picker.ts";
import { color, dim } from "./style.ts";
import { boundedTerminalBlock } from "./util/terminal-text.ts";

const MODE_ENV = "HERDR_PICKERS_MODE";
const EXIT_SIGNALS = ["SIGHUP", "SIGINT", "SIGTERM"] as const;
const COMBINED_FAILURE_MESSAGE = "Picker failed and its popup could not be closed.";

async function main(): Promise<void> {
  const removeSignalHandlers = closePopupOnSignals(process.env);
  try {
    await withPopupClose(async () => {
      const mode = parseMode(process.env[MODE_ENV]);
      const config = loadConfig(process.env);
      const outcome = await runPicker(mode, { herdr: new Herdr(), env: process.env, config });
      if (outcome === "no-agents") {
        console.log(dim(mode === "repo-agents" ? "No repository agents found." : "No agents found."));
      }
    }, () => closePopup(process.env));
  } finally {
    removeSignalHandlers();
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

function closePopupOnSignals(env: Record<string, string | undefined>): () => void {
  let closing = false;
  const handlers = EXIT_SIGNALS.map((signal) => {
    const handler = (): void => {
      if (closing) return;
      closing = true;
      remove();
      void closePopup(env).finally(() => process.kill(process.pid, signal));
    };
    process.on(signal, handler);
    return { signal, handler };
  });
  const remove = (): void => {
    for (const { signal, handler } of handlers) process.off(signal, handler);
  };
  return remove;
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(color("red", formatPaneError(error)));
    process.exit(1);
  }
}
