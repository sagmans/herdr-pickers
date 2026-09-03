import { describe, expect, test } from "bun:test";

import { parseConfig } from "../src/config/config.ts";
import { parseInput } from "../src/terminal-picker-input.ts";

const CONFIG_PATH = "/example/config.toml";
const KEY_UP = "\x1b[A";
const KEY_DOWN = "\x1b[B";
const KEY_ENTER = "\r";
const KEY_BACKSPACE = "\x7f";
const KEY_CTRL_H = "\x08";
const KEY_CTRL_J = "\x0a";
const KEY_CTRL_K = "\x0b";
const KEY_CTRL_N = "\x0e";
const KEY_CTRL_P = "\x10";
const KEY_ESCAPE = "\x1b";
const MOUSE_PRESS = "\x1b[<0;2;1M";
const INCOMPLETE_MOUSE_PRESS = "\x1b[<0;2";
const C1_COLOR_SEQUENCE = "\u009b31m";
const VIM_KEYMAP_TOML = '[keymap]\nup = ["up", "ctrl-k"]\ndown = ["down", "ctrl-j"]\n';
const CONTROL_ONLY_KEYMAP_TOML = '[keymap]\nup = ["ctrl-k"]\ndown = ["ctrl-j"]\n';
const CTRL_H_KEYMAP_TOML = '[keymap]\nup = ["ctrl-h"]\n';
const CUSTOM_INPUT = KEY_CTRL_K + KEY_CTRL_J + KEY_ENTER + KEY_CTRL_P + KEY_CTRL_N + "x";
const DEFAULT_INPUT = MOUSE_PRESS + KEY_UP + KEY_CTRL_N + KEY_ENTER + "pi";
const EXPECTED_CUSTOM_EVENTS = [
  { type: "up" },
  { type: "down" },
  { type: "accept" },
  { type: "text", value: "x" },
] as const;

const vimKeymap = parseConfig(VIM_KEYMAP_TOML, CONFIG_PATH).keymap;
const controlOnlyKeymap = parseConfig(CONTROL_ONLY_KEYMAP_TOML, CONFIG_PATH).keymap;

describe("terminal input parsing", () => {
  test("parses SGR mouse presses and default keyboard controls", () => {
    const parsed = parseInput(DEFAULT_INPUT);

    expect(parsed.remainder).toBe("");
    expect(parsed.events).toEqual([
      { type: "mouse", button: "left", column: 2, row: 1, released: false },
      { type: "up" },
      { type: "down" },
      { type: "accept" },
      { type: "text", value: "p" },
      { type: "text", value: "i" },
    ]);
  });

  test("retains an incomplete SGR mouse sequence for the next chunk", () => {
    expect(parseInput(INCOMPLETE_MOUSE_PRESS)).toEqual({ events: [], remainder: INCOMPLETE_MOUSE_PRESS });
  });

  test("retains a lone escape byte and ignores C1 control sequences", () => {
    expect(parseInput(KEY_ESCAPE)).toEqual({ events: [], remainder: KEY_ESCAPE });
    expect(parseInput(C1_COLOR_SEQUENCE)).toEqual({ events: [], remainder: "" });
  });
});

describe("terminal input keymap", () => {
  test("uses every configured key and ignores replaced defaults", () => {
    expect(parseInput(CUSTOM_INPUT, vimKeymap)).toEqual({ events: EXPECTED_CUSTOM_EVENTS, remainder: "" });
  });

  test("ignores arrow sequences removed by action replacement", () => {
    expect(parseInput(KEY_UP + KEY_DOWN, controlOnlyKeymap)).toEqual({ events: [], remainder: "" });
  });

  test("keeps DEL Backspace fixed while Ctrl-H remains configurable", () => {
    const ctrlHKeymap = parseConfig(CTRL_H_KEYMAP_TOML, CONFIG_PATH).keymap;

    expect(parseInput(KEY_CTRL_H + KEY_BACKSPACE, ctrlHKeymap)).toEqual({
      events: [{ type: "up" }, { type: "backspace" }],
      remainder: "",
    });
  });
});
