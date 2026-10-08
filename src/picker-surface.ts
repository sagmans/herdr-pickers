// One picker surface lifetime: the terminal owner, the popup or overlay close,
// and the error precedence between picker work and dismissal. The pane
// entrypoint runs every mode through this, so close ordering cannot diverge.
import { closePickerSurface, type PickerSurface } from "./client/popup.ts";
import { PickerTerminal, type TerminalAdapter } from "./picker-terminal.ts";

const COMBINED_FAILURE_MESSAGE = "Picker failed and its surface could not be closed.";

type Settled<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };

/**
 * Runs one mode on one terminal lifetime. The surface closes after the work and
 * before terminal restore, because restoring first would expose the blank
 * primary screen inside the surface. Close failures never mask a picker error,
 * and both are reported together when both fail.
 */
export async function withPickerSurface<T>(
  surface: PickerSurface,
  socketPath: string | undefined,
  adapter: TerminalAdapter | undefined,
  work: (terminal: PickerTerminal) => Promise<T>,
  close: () => Promise<void> = () => closePickerSurface(surface, socketPath),
): Promise<T> {
  const terminal = new PickerTerminal(adapter);
  const picker = await settle(() => work(terminal));
  const dismissal = await settle(close);
  terminal.close();
  if (!picker.ok) {
    if (!dismissal.ok) throw new AggregateError([picker.error, dismissal.error], COMBINED_FAILURE_MESSAGE);
    throw picker.error;
  }
  if (!dismissal.ok) throw dismissal.error;
  return picker.value;
}

async function settle<T>(work: () => Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    return { ok: false, error };
  }
}
