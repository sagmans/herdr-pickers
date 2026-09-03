import { DEFAULT_PICKER_KEYMAP, type PickerKeyAction, type PickerKeymap } from "./config/config.ts";

const MOUSE_PATTERN = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/;
const CSI_PATTERN = /^\x1b\[[0-9;?]*[ -/]*[@-~]/;
const C1_CSI_PATTERN = /^\u009b[0-9;?]*[ -/]*[@-~]/;
export const ESCAPE_KEY_SEQUENCE = "\x1b";
const MOUSE_PREFIX = "\x1b[<";
const CSI_PREFIX = "\x1b[";
const KEY_BACKSPACE = "\x7f";
const MOUSE_LEFT = 0;
const MOUSE_WHEEL_UP = 64;
const MOUSE_WHEEL_DOWN = 65;
const PRINTABLE_CODE_MIN = 0x20;
const DELETE_CODE = 0x7f;
const C1_CONTROL_MAX = 0x9f;
const SINGLE_CHARACTER_LENGTH = 1;
const MIN_CSI_SEQUENCE_LENGTH = 3;

export interface MouseEvent {
  readonly type: "mouse";
  readonly button: "left" | "wheel-up" | "wheel-down" | "other";
  readonly column: number;
  readonly row: number;
  readonly released: boolean;
}

export type InputEvent =
  | MouseEvent
  | { readonly type: "up" }
  | { readonly type: "down" }
  | { readonly type: "accept" }
  | { readonly type: "escape" }
  | { readonly type: "close" }
  | { readonly type: "reload" }
  | { readonly type: "backspace" }
  | { readonly type: "text"; readonly value: string };

export interface ParsedInput {
  readonly events: readonly InputEvent[];
  readonly remainder: string;
}

export function parseInput(data: string, keymap: PickerKeymap = DEFAULT_PICKER_KEYMAP): ParsedInput {
  const events: InputEvent[] = [];
  const mappedSequences = [...keymap.keys()]
    .filter((sequence) => sequence.length > SINGLE_CHARACTER_LENGTH)
    .toSorted((left, right) => right.length - left.length);
  let remaining = data;

  while (remaining.length > 0) {
    const mouse = MOUSE_PATTERN.exec(remaining);
    if (mouse) {
      events.push({
        type: "mouse",
        button: mouseButton(Number(mouse[1])),
        column: Number(mouse[2]),
        row: Number(mouse[3]),
        released: mouse[4] === "m",
      });
      remaining = remaining.slice(mouse[0].length);
      continue;
    }
    if (remaining.startsWith(MOUSE_PREFIX)) return { events, remainder: remaining };
    if (remaining === ESCAPE_KEY_SEQUENCE) return { events, remainder: remaining };

    const mappedSequence = mappedSequences.find((sequence) => remaining.startsWith(sequence));
    if (mappedSequence !== undefined) {
      const event = mappedKeyEvent(mappedSequence, keymap);
      if (event !== undefined) events.push(event);
      remaining = remaining.slice(mappedSequence.length);
      continue;
    }
    if (mappedSequences.some((sequence) => sequence.startsWith(remaining))) {
      return { events, remainder: remaining };
    }

    const csi = CSI_PATTERN.exec(remaining);
    if (csi) {
      remaining = remaining.slice(csi[0].length);
      continue;
    }
    const c1Csi = C1_CSI_PATTERN.exec(remaining);
    if (c1Csi) {
      remaining = remaining.slice(c1Csi[0].length);
      continue;
    }
    if (remaining.startsWith(CSI_PREFIX) && remaining.length < MIN_CSI_SEQUENCE_LENGTH) {
      return { events, remainder: remaining };
    }

    const character = Array.from(remaining)[0];
    if (character === undefined) break;
    remaining = remaining.slice(character.length);
    if (character === KEY_BACKSPACE) {
      events.push({ type: "backspace" });
      continue;
    }
    const event = mappedKeyEvent(character, keymap);
    if (event !== undefined) {
      events.push(event);
    } else if (isPrintable(character)) {
      events.push({ type: "text", value: character });
    }
  }

  return { events, remainder: "" };
}

export function mappedKeyEvent(sequence: string, keymap: PickerKeymap): InputEvent | undefined {
  const action = keymap.get(sequence);
  if (action === undefined) return undefined;
  return actionEvent(action);
}

function actionEvent(action: PickerKeyAction): InputEvent {
  switch (action) {
    case "up":
    case "down":
    case "accept":
    case "escape":
    case "close":
    case "reload":
      return { type: action };
    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
}

function mouseButton(code: number): MouseEvent["button"] {
  switch (code) {
    case MOUSE_LEFT:
      return "left";
    case MOUSE_WHEEL_UP:
      return "wheel-up";
    case MOUSE_WHEEL_DOWN:
      return "wheel-down";
    default:
      return "other";
  }
}

function isPrintable(value: string): boolean {
  const code = value.codePointAt(0);
  return code !== undefined && code >= PRINTABLE_CODE_MIN && (code < DELETE_CODE || code > C1_CONTROL_MAX);
}
