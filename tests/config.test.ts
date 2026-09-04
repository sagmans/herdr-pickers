import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { defaultConfigToml, loadConfig, parseConfig } from "../src/config/config.ts";

const CONFIG_FILE_NAME = "config.toml";
const CONFIG_PATH = "/example/config.toml";
const KEY_UP = "\x1b[A";
const KEY_DOWN = "\x1b[B";
const KEY_ENTER = "\r";
const KEY_ESCAPE = "\x1b";
const KEY_CTRL_C = "\x03";
const KEY_CTRL_J = "\x0a";
const KEY_CTRL_K = "\x0b";
const KEY_CTRL_N = "\x0e";
const KEY_CTRL_P = "\x10";
const KEY_CTRL_R = "\x12";
const VIM_KEYMAP_TOML = '[keymap]\nup = ["up", "ctrl-k"]\ndown = ["down", "ctrl-j"]\n';
const EMPTY_UP_KEYMAP_TOML = "[keymap]\nup = []\n";
const BACKSPACE_ACTION_TOML = '[keymap]\nbackspace = ["ctrl-h"]\n';
const BACKSPACE_KEY_TOML = '[keymap]\nup = ["backspace"]\n';
const CONFLICTING_KEYMAP_TOML = '[keymap]\naccept = ["enter"]\nreload = ["ctrl-m"]\n';
const ESCAPE_ACTION_TOML = '[keymap]\nescape = ["up"]\n';
const CLOSE_ACTION_TOML = '[keymap]\nclose = ["down"]\n';
const ESCAPE_KEY_TOML = '[keymap]\nup = ["escape"]\n';
const CTRL_C_KEY_TOML = '[keymap]\ndown = ["ctrl-c"]\n';
const INVALID_KEYMAP_TOML = '[keymap]\nup = ["left"]\n';
const INVALID_KEYMAP_VALUE_TOML = '[keymap]\nup = "ctrl-k"\n';
const INVALID_KEYMAP_TABLE_TOML = 'keymap = "ctrl-k"\n';
const CONFIG_PATH_PATTERN = /config\.toml/;

function tempConfigDir(): string {
  return mkdtempSync(join(tmpdir(), "herdr-pickers-config-"));
}

describe("plugin config", () => {
  test("missing config writes default file and returns empty roots", () => {
    const dir = tempConfigDir();
    const configPath = join(dir, CONFIG_FILE_NAME);

    const config = loadConfig({ HERDR_PLUGIN_CONFIG_DIR: dir });

    expect(config.projects.roots).toEqual([]);
    expect(config.keymap.get(KEY_UP)).toBe("up");
    expect(readFileSync(configPath, "utf-8")).toBe(defaultConfigToml());
  });

  test("uses the current bindings when keymap is absent", () => {
    const keymap = parseConfig("", CONFIG_PATH).keymap;

    expect([...keymap]).toEqual([
      [KEY_UP, "up"],
      [KEY_CTRL_P, "up"],
      [KEY_DOWN, "down"],
      [KEY_CTRL_N, "down"],
      [KEY_ENTER, "accept"],
      [KEY_CTRL_R, "reload"],
    ]);
  });

  test("replaces each configured action with multiple keys", () => {
    const keymap = parseConfig(VIM_KEYMAP_TOML, CONFIG_PATH).keymap;

    expect(keymap.get(KEY_UP)).toBe("up");
    expect(keymap.get(KEY_CTRL_K)).toBe("up");
    expect(keymap.get(KEY_CTRL_P)).toBeUndefined();
    expect(keymap.get(KEY_DOWN)).toBe("down");
    expect(keymap.get(KEY_CTRL_J)).toBe("down");
    expect(keymap.get(KEY_CTRL_N)).toBeUndefined();
    expect(keymap.get(KEY_ENTER)).toBe("accept");
    expect(keymap.get(KEY_ESCAPE)).toBeUndefined();
    expect(keymap.get(KEY_CTRL_C)).toBeUndefined();
  });

  test("allows an empty action list to remove its default keys", () => {
    const keymap = parseConfig(EMPTY_UP_KEYMAP_TOML, CONFIG_PATH).keymap;

    expect(keymap.get(KEY_UP)).toBeUndefined();
    expect(keymap.get(KEY_CTRL_P)).toBeUndefined();
    expect(keymap.get(KEY_DOWN)).toBe("down");
  });

  test("rejects invalid and conflicting keymap entries with the config path", () => {
    for (const source of [
      BACKSPACE_ACTION_TOML,
      BACKSPACE_KEY_TOML,
      ESCAPE_ACTION_TOML,
      CLOSE_ACTION_TOML,
      ESCAPE_KEY_TOML,
      CTRL_C_KEY_TOML,
      CONFLICTING_KEYMAP_TOML,
      INVALID_KEYMAP_TOML,
      INVALID_KEYMAP_VALUE_TOML,
      INVALID_KEYMAP_TABLE_TOML,
    ]) {
      expect(() => parseConfig(source, CONFIG_PATH)).toThrow(CONFIG_PATH_PATTERN);
    }
  });

  test("empty roots are allowed", () => {
    const dir = tempConfigDir();
    writeFileSync(join(dir, CONFIG_FILE_NAME), "[projects]\nroots = []\n", "utf-8");

    expect(loadConfig({ HERDR_PLUGIN_CONFIG_DIR: dir }).projects.roots).toEqual([]);
  });

  test("missing projects table is treated as empty roots", () => {
    expect(parseConfig("", "/example/config.toml").projects.roots).toEqual([]);
  });

  test("non-array roots fail with the config path", () => {
    expect(() => parseConfig('[projects]\nroots = "nope"\n', CONFIG_PATH)).toThrow(/projects.*roots.*config\.toml/);
  });

  test("non-table projects fail with the config path", () => {
    expect(() => parseConfig('projects = "nope"\n', CONFIG_PATH)).toThrow(/\[projects\].*config\.toml/);
  });

  test("malformed TOML includes the config path", () => {
    expect(() => parseConfig("[projects]\nroots = [\n", CONFIG_PATH)).toThrow(/Invalid TOML.*\/example\/config\.toml/);
  });

  test("valid roots expand home", () => {
    const config = parseConfig('[projects]\nroots = ["~/source"]\n', CONFIG_PATH);

    expect(config.projects.roots[0]).toContain("/source");
  });
});
