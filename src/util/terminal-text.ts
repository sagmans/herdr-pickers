// One sanitizer for every untrusted string that can reach terminal output.
// Repository metadata, herdr/fzf stderr, and error details all pass through
// here so hidden escapes, bidi controls, and control bytes can never be
// replayed into the host terminal.
const ANSI_OSC_PATTERN = /\u001B\](?:[^\u0007\u001B]|\u001B(?!\\))*(?:\u0007|\u001B\\|$)/g;
const ANSI_CSI_PATTERN = /(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]/g;
const ANSI_ESCAPE_PATTERN = /\u001B[@-_]/g;
// Bidi overrides can visually reorder adjacent labels to disguise content.
const BIDI_CONTROL_PATTERN = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;
const CONTROL_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
const WHITESPACE_PATTERN = /\s+/g;

/** One field or line: long enough for real labels, short enough that hostile input cannot flood a row. */
export const MAX_TERMINAL_TEXT_LENGTH = 1024;
/** Whole multi-line error block, so aggregate failures stay readable but bounded. */
export const MAX_AGGREGATE_MESSAGE_LENGTH = 2048;

/** Single-line safe form: escapes and bidi controls dropped, control bytes and whitespace runs collapsed. */
export function sanitizeTerminalText(value: string): string {
  return value
    .replace(ANSI_OSC_PATTERN, "")
    .replace(ANSI_CSI_PATTERN, "")
    .replace(ANSI_ESCAPE_PATTERN, "")
    .replace(BIDI_CONTROL_PATTERN, "")
    .replace(CONTROL_PATTERN, " ")
    .replace(WHITESPACE_PATTERN, " ")
    .trim();
}

/** Sanitized and length-capped, for untrusted text embedded in messages. */
export function boundedTerminalText(value: string, maxLength = MAX_TERMINAL_TEXT_LENGTH): string {
  return sanitizeTerminalText(value).slice(0, maxLength);
}

// Multi-line messages keep their line structure while each line is sanitized
// and the whole block stays bounded.
export function boundedTerminalBlock(value: string, maxLength = MAX_AGGREGATE_MESSAGE_LENGTH): string {
  return value
    .split("\n")
    .map((line) => sanitizeTerminalText(line))
    .join("\n")
    .slice(0, maxLength);
}
