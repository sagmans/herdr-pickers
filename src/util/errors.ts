// User-facing error rendering shared by every entrypoint. Error text can carry
// Herdr, Git, or filesystem detail, so both forms are sanitized and bounded.
import { boundedTerminalBlock, boundedTerminalText } from "./terminal-text.ts";

/** Multi-line form for interactive output: aggregate causes stay visible, one per line. */
export function formatErrorBlock(error: unknown): string {
  const rendered = error instanceof AggregateError
    ? [error.message, ...error.errors.map(formatErrorBlock)].join("\n")
    : error instanceof Error
      ? error.message
      : String(error);
  // Popup output is user-facing: every line is sanitized and the whole
  // aggregate stays bounded so failures cannot flood the terminal.
  return boundedTerminalBlock(rendered);
}

/**
 * One stack-free line for event-hook logs: printing the Error object would let
 * Bun dump source paths, and hooks must not flood Herdr's event log.
 */
export function formatEventFailure(reason: string, error: unknown): string {
  const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
  return boundedTerminalText(`${reason}: ${message}`);
}
