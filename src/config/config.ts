import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { hasErrorCode, isRecord } from "../util/objects.ts";

export const PLUGIN_ID = "herdr-pickers";
export const CONFIG_FILE_NAME = "config.toml";

const DEFAULT_CONFIG = [
  "[projects]",
  "# Optional. Parent directories that contain project repositories.",
  "# When empty, navigation mirrors repositories Herdr already tracks.",
  "# Set roots to include repositories not yet opened in Herdr.",
  "# Example: roots = [\"~/projects\"]",
  "roots = []",
  "",
].join("\n");

export interface HerdrPickersConfig {
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
  return { projects: { roots: [] } };
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

  return { projects: { roots } };
}

export function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
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
