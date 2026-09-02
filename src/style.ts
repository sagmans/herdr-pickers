// Picker rows use the centralized RGB palette; basic ANSI remains scoped to
// standalone error output.

const ESC = "\x1b[";
const RGB_FOREGROUND_CODE = "38;2";
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

export type Fg = keyof typeof FG;

export interface RgbColor {
  readonly red: number;
  readonly green: number;
  readonly blue: number;
}

function wrap(code: number | string, text: string): string {
  return text.length === 0 ? text : `${ESC}${code}m${text}${RESET}`;
}

export function bold(text: string): string {
  return wrap(ATTR.bold, text);
}

export function dim(text: string): string {
  return wrap(ATTR.dim, text);
}

export function color(name: Fg, text: string): string {
  return wrap(FG[name], text);
}

export function trueColor(value: RgbColor, text: string): string {
  return wrap(`${RGB_FOREGROUND_CODE};${value.red};${value.green};${value.blue}`, text);
}