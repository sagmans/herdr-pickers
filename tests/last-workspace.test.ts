import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { formatEventFailure, parseSubcommand, runLastWorkspace } from "../src/actions/last-workspace.ts";
import { Herdr, type CommandRunner } from "../src/client/herdr.ts";
import type { WorkspaceMemory } from "../src/last-workspace/memory.ts";
import { StateStore } from "../src/last-workspace/store.ts";

interface FakeHerdr {
  readonly herdr: Herdr;
  readonly focusCalls: string[];
}

const TEMP_PREFIX = "herdr-pickers-last-ws-orch-";
const CURRENT_W2_LAST_W1: WorkspaceMemory = { kind: "current", current: "w2", last: "w1" };

function fakeHerdr(
  workspaces: ReadonlyArray<readonly [string, boolean]>,
  options: { readonly focusThrows?: boolean } = {},
): FakeHerdr {
  const focusCalls: string[] = [];
  const list = workspaces.map(([workspaceId, focused]) => ({ workspace_id: workspaceId, focused }));
  const runner: CommandRunner = async (argv) => {
    const args = argv.slice(1);
    if (args[0] === "workspace" && args[1] === "list") {
      return { stdout: JSON.stringify({ result: { type: "workspace_list", workspaces: list } }), stderr: "", exitCode: 0 };
    }
    if (args[0] === "workspace" && args[1] === "focus") {
      if (options.focusThrows) throw new Error("connection failure");
      focusCalls.push(args[2] ?? "");
    }
    return { stdout: '{"result":{}}', stderr: "", exitCode: 0 };
  };
  return { herdr: new Herdr({ runner }), focusCalls };
}

function tempDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `${TEMP_PREFIX}${label}-`));
}

function runtime(herdr: Herdr, stateDir: string, env: Record<string, string | undefined> = {}) {
  return { env, herdr, store: new StateStore({ stateDir }) };
}

function eventJson(workspaceId: string): string {
  return JSON.stringify({ event: "workspace_focused", data: { type: "workspace_focused", workspace_id: workspaceId } });
}

describe("last-workspace toggle", () => {
  test("seeds empty state from live focus without focusing", async () => {
    const dir = tempDir("seed");
    const { herdr, focusCalls } = fakeHerdr([["w1", true]]);

    await runLastWorkspace("toggle", runtime(herdr, dir));

    expect(focusCalls).toEqual([]);
    expect(new StateStore({ stateDir: dir }).read().memory).toEqual({ kind: "current", current: "w1", last: undefined });
  });

  test("focuses remembered last workspace", async () => {
    const dir = tempDir("focus-last");
    new StateStore({ stateDir: dir }).write(CURRENT_W2_LAST_W1);
    const { herdr, focusCalls } = fakeHerdr([["w1", false], ["w2", true]]);

    await runLastWorkspace("toggle", runtime(herdr, dir));

    expect(focusCalls).toEqual(["w1"]);
  });

  test("clears stale last workspace", async () => {
    const dir = tempDir("stale-last");
    new StateStore({ stateDir: dir }).write(CURRENT_W2_LAST_W1);
    const { herdr, focusCalls } = fakeHerdr([["w2", true]]);

    await runLastWorkspace("toggle", runtime(herdr, dir));

    expect(focusCalls).toEqual([]);
    expect(new StateStore({ stateDir: dir }).read().memory).toEqual({ kind: "current", current: "w2", last: undefined });
  });
});

describe("last-workspace events", () => {
  test("records verified focus transitions", async () => {
    const dir = tempDir("focused");
    const first = fakeHerdr([["w2", true]]);
    await runLastWorkspace("focused", runtime(first.herdr, dir, { HERDR_PLUGIN_EVENT_JSON: eventJson("w2") }));

    const second = fakeHerdr([["w1", true], ["w2", false]]);
    await runLastWorkspace("focused", runtime(second.herdr, dir, { HERDR_PLUGIN_EVENT_JSON: eventJson("w1") }));

    expect(new StateStore({ stateDir: dir }).read().memory).toEqual({ kind: "current", current: "w1", last: "w2" });
  });

  test("ignores stale focus events", async () => {
    const dir = tempDir("stale-focused");
    new StateStore({ stateDir: dir }).write({ kind: "current", current: "w2", last: undefined });
    const { herdr } = fakeHerdr([["w2", true]]);

    await runLastWorkspace("focused", runtime(herdr, dir, { HERDR_PLUGIN_EVENT_JSON: eventJson("w3") }));

    expect(new StateStore({ stateDir: dir }).read().memory).toEqual({ kind: "current", current: "w2", last: undefined });
  });

  test("prunes closed workspaces without jumping when non-focused workspace closes", async () => {
    const dir = tempDir("closed-non-focused");
    new StateStore({ stateDir: dir }).write(CURRENT_W2_LAST_W1);
    const { herdr, focusCalls } = fakeHerdr([["w2", true]]);

    await runLastWorkspace("closed", runtime(herdr, dir, { HERDR_PLUGIN_EVENT_JSON: eventJson("w1") }));

    expect(focusCalls).toEqual([]);
    expect(new StateStore({ stateDir: dir }).read().memory).toEqual({ kind: "current", current: "w2", last: undefined });
  });

  test("jumps to previous workspace when closing focused workspace", async () => {
    const dir = tempDir("closed-focused-jump");
    new StateStore({ stateDir: dir }).write({ kind: "current", current: "w2", last: "w1" });
    const { herdr, focusCalls } = fakeHerdr([["w1", false], ["w3", true]]);

    await runLastWorkspace("closed", runtime(herdr, dir, { HERDR_PLUGIN_EVENT_JSON: eventJson("w2") }));

    expect(focusCalls).toEqual(["w1"]);
    expect(new StateStore({ stateDir: dir }).read().memory).toEqual({ kind: "current", current: "w1", last: undefined });
  });

  test("does not jump when closing only workspace", async () => {
    const dir = tempDir("closed-only");
    new StateStore({ stateDir: dir }).write({ kind: "current", current: "w1", last: undefined });
    const { herdr, focusCalls } = fakeHerdr([]);

    await runLastWorkspace("closed", runtime(herdr, dir, { HERDR_PLUGIN_EVENT_JSON: eventJson("w1") }));

    expect(focusCalls).toEqual([]);
    expect(new StateStore({ stateDir: dir }).read().memory).toEqual({ kind: "empty" });
  });

  test("does not jump when previous workspace no longer exists", async () => {
    const dir = tempDir("closed-dead-previous");
    new StateStore({ stateDir: dir }).write({ kind: "current", current: "w2", last: "w1" });
    const { herdr, focusCalls } = fakeHerdr([["w3", true]]);

    await runLastWorkspace("closed", runtime(herdr, dir, { HERDR_PLUGIN_EVENT_JSON: eventJson("w2") }));

    expect(focusCalls).toEqual([]);
    expect(new StateStore({ stateDir: dir }).read().memory).toEqual({ kind: "current", current: "w3", last: "w1" });
  });

  test("survives focus command failure without throwing", async () => {
    const dir = tempDir("closed-focus-error");
    new StateStore({ stateDir: dir }).write({ kind: "current", current: "w2", last: "w1" });
    const { herdr } = fakeHerdr([["w1", false], ["w3", true]], { focusThrows: true });

    await runLastWorkspace("closed", runtime(herdr, dir, { HERDR_PLUGIN_EVENT_JSON: eventJson("w2") }));

    expect(new StateStore({ stateDir: dir }).read().memory).toEqual({ kind: "current", current: "w3", last: "w1" });
  });
});

describe("last-workspace subcommands", () => {
  test("accepts known values and rejects unknown ones", () => {
    expect(parseSubcommand("toggle")).toBe("toggle");
    expect(parseSubcommand("focused")).toBe("focused");
    expect(parseSubcommand("closed")).toBe("closed");
    expect(() => parseSubcommand("bogus")).toThrow(/Usage/);
  });
});

describe("last-workspace failure reporting", () => {
  test("event failure report is one sanitized line without stack or absolute paths", () => {
    const failure = new Error("focus refused\n    at run (/home/adversary/leak/src/a.ts:2:3)");

    const line = formatEventFailure("failed to focus previous workspace on close", failure);

    expect(line).not.toContain("\n");
    expect(line).not.toContain("/Users");
    expect(line).not.toContain(".ts:");
    expect(line).toBe("failed to focus previous workspace on close: focus refused");
  });
});
