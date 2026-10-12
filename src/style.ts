// Picker rows use the centralized RGB palette; basic ANSI remains scoped to
// standalone error output.

const ESC = "\x1b[";
const RGB_FOREGROUND_CODE = "38;2";
/** Full SGR reset; appended after each styled span so styles never leak into later text. */
export const RESET = `${ESC}0m`;

// SGR attribute codes used for emphasis (bold headers) and de-emphasis (dim).
const ATTR = {
  bold: 1,
  dim: 2,
} as const;

const FG = {
  red: 31,
  green: 32,
  yellow: 33,
  blue: 34,
  magenta: 35,
  cyan: 36,
  gray: 90,
} as const;

/** Basic ANSI color names, reserved for standalone error output. */
export type Fg = keyof typeof FG;

/** 24-bit color; components are expected in 0-255. */
export interface RgbColor {
  readonly red: number;
  readonly green: number;
  readonly blue: number;
}

function wrap(code: number | string, text: string): string {
  return text.length === 0 ? text : `${ESC}${code}m${text}${RESET}`;
}

/** Emphasis for headers and selected identities; empty text stays empty. */
export function bold(text: string): string {
  return wrap(ATTR.bold, text);
}

/** De-emphasis for low-information rows such as the unknown-repository group. */
export function dim(text: string): string {
  return wrap(ATTR.dim, text);
}

/** Basic ANSI color, used only by standalone error output. */
export function color(name: Fg, text: string): string {
  return wrap(FG[name], text);
}

/** RGB foreground for picker rows; pairs with PICKER_PALETTE. */
export function trueColor(value: RgbColor, text: string): string {
  return wrap(`${RGB_FOREGROUND_CODE};${value.red};${value.green};${value.blue}`, text);
}