// Raw key sequences a terminal sends for the keys the picker understands. The
// keymap config and the input parser both need them; keeping them here lets
// config name keys without importing the parser that consumes its keymap.

/** Arrow keys in normal cursor mode. */
export const KEY_UP = "\x1b[A";
/** Down arrow in normal cursor mode; application-mode arrows are not bound. */
export const KEY_DOWN = "\x1b[B";
/** Carriage return, as sent in raw mode. */
export const KEY_ENTER = "\r";
/** Also the prefix of every CSI sequence, which is why a lone one is ambiguous. */
export const ESCAPE_KEY_SEQUENCE = "\x1b";
/** DEL, which most terminals send for Backspace. */
export const KEY_BACKSPACE = "\x7f";
/** ETX; raw mode delivers it as input, so the picker must treat it as cancel itself. */
export const KEY_CTRL_C = "\x03";
/** Ctrl-<letter> sends the letter's code with the upper bits cleared. */
export const CONTROL_CODE_MASK = 0x1f;
