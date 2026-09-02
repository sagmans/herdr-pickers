import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { defaultConfigToml, loadConfig, parseConfig } from "../src/config/config.ts";

const CONFIG_FILE_NAME = "config.toml";

function tempConfigDir(): string {
  return mkdtempSync(join(tmpdir(), "herdr-pickers-config-"));
}

describe("navigation config", () => {
  test("missing config writes default file and returns empty roots", () => {
    const dir = tempConfigDir();
    const configPath = join(dir, CONFIG_FILE_NAME);

    expect(loadConfig({ HERDR_PLUGIN_CONFIG_DIR: dir }).projects.roots).toEqual([]);
    expect(readFileSync(configPath, "utf-8")).toBe(defaultConfigToml());
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
    expect(() => parseConfig('[projects]\nroots = "nope"\n', "/example/config.toml")).toThrow(/projects.*roots.*config\.toml/);
  });

  test("non-table projects fail with the config path", () => {
    expect(() => parseConfig('projects = "nope"\n', "/example/config.toml")).toThrow(/\[projects\].*config\.toml/);
  });

  test("malformed TOML includes the config path", () => {
    expect(() => parseConfig("[projects]\nroots = [\n", "/example/config.toml")).toThrow(/Invalid TOML.*\/example\/config\.toml/);
  });

  test("valid roots expand home", () => {
    const config = parseConfig('[projects]\nroots = ["~/source"]\n', "/example/config.toml");

    expect(config.projects.roots[0]).toContain("/source");
  });
});
