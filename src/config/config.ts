import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { hasErrorCode, isRecord } from "../util/objects.ts";

export const PLUGIN_ID = "herdr-pickers";
export const CONFIG_FILE_NAME = "config.toml";

export const PICKER_PLACEMENTS = ["popup", "overlay"] as const;
export type PickerPlacement = (typeof PICKER_PLACEMENTS)[number];
export const DEFAULT_PICKER_PLACEMENT: PickerPlacement = "popup";
export type PickerKeyAction = "up" | "down" | "accept" | "reload";
export type PickerKeymap = ReadonlyMap<string, PickerKeyAction>;

const KEY_UP = "\x1b[A";
const KEY_DOWN = "\x1b[B";
const KEY_ENTER = "\r";
const CONTROL_KEY_PATTERN = /^ctrl-([a-z])$/;
const CONTROL_CODE_MASK = 0x1f;
const KEYMAP_ACTIONS = ["up", "down", "accept", "reload"] as const satisfies readonly PickerKeyAction[];
const KEYMAP_ACTION_SET: ReadonlySet<string> = new Set(KEYMAP_ACTIONS);
const FIXED_KEY_NAMES: ReadonlySet<string> = new Set(["escape", "ctrl-c"]);
const NAMED_KEY_SEQUENCES: ReadonlyMap<string, string> = new Map([
  ["up", KEY_UP],
  ["down", KEY_DOWN],
  ["enter", KEY_ENTER],
]);
const DEFAULT_KEY_BINDINGS: Readonly<Record<PickerKeyAction, readonly string[]>> = {
  up: ["up", "ctrl-p"],
  down: ["down", "ctrl-n"],
  accept: ["enter"],
  reload: ["ctrl-r"],
};
const INVALID_DEFAULT_KEY_MESSAGE = "Invalid default picker key";
const PLACEMENT_SET: ReadonlySet<string> = new Set(PICKER_PLACEMENTS);
const PLACEMENT_ERROR_MESSAGE = "placement must be 'popup' or 'overlay'";
const DEFAULT_CONFIG = [
  "# Optional. popup (default) is a 75% centered float.",
  "# overlay is a full-pane zoom and hides Kitty images from the pane underneath.",
  "# placement = \"overlay\"",
  "",
  "[projects]",
  "# Optional. Parent directories that contain project repositories.",
  "# When empty, navigation mirrors repositories Herdr already tracks.",
  "# Set roots to include repositories not yet opened in Herdr.",
  "# Example: roots = [\"~/projects\"]",
  "roots = []",
  "",
  "# Optional. Each action list replaces only that action's default keys.",
  "# Actions: up, down, accept, reload.",
  "# Keys: up, down, enter, ctrl-a through ctrl-z, except ctrl-c.",
  "# Escape and Ctrl-C are fixed cancellation controls.",
  "# [keymap]",
  "# up = [\"up\", \"ctrl-k\"]",
  "# down = [\"down\", \"ctrl-j\"]",
  "",
].join("\n");

export const DEFAULT_PICKER_KEYMAP: PickerKeymap = buildDefaultPickerKeymap();

export interface HerdrPickersConfig {
  readonly placement: PickerPlacement;
  readonly keymap: PickerKeymap;
  readonly projects: {
    readonly roots: readonly string[];
  };
}

export class ConfigError extends Error {
  constructor(message: string, readonly configPath: string) {
    super(`${message} (${configPath})`);
    this.name = "ConfigError";
  }
}

export function defaultConfigToml(): string {
  return DEFAULT_CONFIG;
}

export function resolvePluginConfigDir(env: Record<string, string | undefined> = process.env): string {
  return env.HERDR_PLUGIN_CONFIG_DIR ?? join(homedir(), ".config", "herdr", "plugins", "config", PLUGIN_ID);
}

export function resolveConfigPath(env: Record<string, string | undefined> = process.env): string {
  return join(resolvePluginConfigDir(env), CONFIG_FILE_NAME);
}

export function loadConfig(env: Record<string, string | undefined> = process.env): HerdrPickersConfig {
  const configPath = resolveConfigPath(env);

  try {
    return parseConfig(readFileSync(configPath, "utf-8"), configPath);
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) throw error;
  }

  // Empty defaults keep first-run navigation aligned with Herdr without
  // silently scanning broad user directories.
  mkdirSync(resolvePluginConfigDir(env), { recursive: true });
  try {
    writeFileSync(configPath, defaultConfigToml(), { encoding: "utf-8", flag: "wx" });
  } catch (error) {
    if (hasErrorCode(error, "EEXIST")) {
      return parseConfig(readFileSync(configPath, "utf-8"), configPath);
    }
    throw error;
  }
  return parseConfig(defaultConfigToml(), configPath);
}

export function parseConfig(source: string, configPath: string): HerdrPickersConfig {
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(source);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`Invalid TOML: ${message}`, configPath);
  }

  const root = expectRecord(parsed, "config", configPath);
  const projects = root.projects === undefined ? {} : expectRecord(root.projects, "[projects]", configPath);
  const roots = expectStringArray(projects.roots, "projects.roots", configPath)
    .map(expandHome)
    .map((value) => resolve(value));
  const keymap = resolvePickerKeymap(root.keymap, configPath);
  const placement = resolvePickerPlacement(root.placement, configPath);

  return { placement, keymap, projects: { roots } };
}

export function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}

function buildDefaultPickerKeymap(): PickerKeymap {
  const keymap = new Map<string, PickerKeyAction>();
  for (const action of KEYMAP_ACTIONS) {
    for (const name of DEFAULT_KEY_BINDINGS[action]) {
      const sequence = decodeKeyName(name);
      if (sequence === undefined) throw new Error(INVALID_DEFAULT_KEY_MESSAGE);
      keymap.set(sequence, action);
    }
  }
  return keymap;
}

function resolvePickerPlacement(value: unknown, configPath: string): PickerPlacement {
  if (value === undefined) return DEFAULT_PICKER_PLACEMENT;
  if (typeof value !== "string" || !isPickerPlacement(value)) {
    throw new ConfigError(PLACEMENT_ERROR_MESSAGE, configPath);
  }
  return value;
}

function isPickerPlacement(value: string): value is PickerPlacement {
  return PLACEMENT_SET.has(value);
}

function resolvePickerKeymap(value: unknown, configPath: string): PickerKeymap {
  if (value === undefined) return DEFAULT_PICKER_KEYMAP;
  const table = expectRecord(value, "[keymap]", configPath);
  for (const action of Object.keys(table)) {
    if (!isPickerKeyAction(action)) throw new ConfigError(`Unknown keymap action '${action}'`, configPath);
  }

  const configured = new Map<PickerKeyAction, readonly string[]>();
  const explicit = new Map<string, { readonly action: PickerKeyAction; readonly name: string }>();
  for (const action of KEYMAP_ACTIONS) {
    const configuredValue = table[action];
    if (configuredValue === undefined) continue;
    const names = expectKeyNames(configuredValue, `keymap.${action}`, configPath);
    configured.set(action, names);
    for (const name of names) {
      if (FIXED_KEY_NAMES.has(name)) {
        throw new ConfigError(`Key '${name}' is a fixed cancellation control`, configPath);
      }
      const sequence = decodeKeyName(name);
      if (sequence === undefined) throw new ConfigError(`Unknown key '${name}' in keymap.${action}`, configPath);
      const previous = explicit.get(sequence);
      if (previous !== undefined) {
        throw new ConfigError(`Key '${name}' in keymap.${action} conflicts with '${previous.name}' in keymap.${previous.action}`, configPath);
      }
      explicit.set(sequence, { action, name });
    }
  }

  const keymap = new Map(DEFAULT_PICKER_KEYMAP);
  for (const action of configured.keys()) {
    for (const [sequence, defaultAction] of keymap) {
      if (defaultAction === action) keymap.delete(sequence);
    }
  }
  for (const [sequence, binding] of explicit) keymap.set(sequence, binding.action);
  return keymap;
}

function decodeKeyName(name: string): string | undefined {
  const named = NAMED_KEY_SEQUENCES.get(name);
  if (named !== undefined) return named;
  const letter = CONTROL_KEY_PATTERN.exec(name)?.[1];
  return letter === undefined ? undefined : String.fromCharCode(letter.charCodeAt(0) & CONTROL_CODE_MASK);
}

function isPickerKeyAction(value: string): value is PickerKeyAction {
  return KEYMAP_ACTION_SET.has(value);
}

function expectKeyNames(value: unknown, label: string, configPath: string): string[] {
  if (!Array.isArray(value)) throw new ConfigError(`${label} must be an array of key names`, configPath);
  return value.map((item) => {
    if (typeof item !== "string") throw new ConfigError(`${label} must contain only strings`, configPath);
    const name = item.trim();
    if (name.length === 0) throw new ConfigError(`${label} must not contain empty key names`, configPath);
    return name;
  });
}

function expectRecord(value: unknown, label: string, configPath: string): Record<string, unknown> {
  if (isRecord(value)) return value;
  throw new ConfigError(`${label} must be a table`, configPath);
}

function expectStringArray(value: unknown, label: string, configPath: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new ConfigError(`${label} must be an array of strings`, configPath);
  }

  const values: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      throw new ConfigError(`${label} must contain only strings`, configPath);
    }
    const trimmed = item.trim();
    if (trimmed.length > 0) values.push(trimmed);
  }
  return values;
}
