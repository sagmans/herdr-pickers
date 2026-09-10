import { expect, test } from "bun:test";

import { Herdr } from "../src/client/herdr.ts";
import { runPicker, type PickerMode } from "../src/picker.ts";
import { runTerminalPicker } from "../src/terminal-picker.ts";
import { FakeTerminal, FakeTimers, VIEWPORT } from "./terminal-picker-test-support.ts";

const STOP_SCREEN = "\x1b[?1049l";
const CANCEL = "\x03";
const ESCAPE = "\x1b";
const ENTER = "\r";
const INTERVAL_MS = 1000;
const FAILURE = new Error("surface close failed");
const MODES: PickerMode[] = ["workspaces", "agents"];
const WORKSPACES = JSON.stringify({ result: { workspaces: [{ workspace_id: "w1", label: "one" }] } });
const AGENTS = JSON.stringify({ result: { agents: [{ terminal_id: "t1", label: "pi", workspace_id: "w1" }] } });
const ITEM = { id: "one", target: "one", display: "one", searchText: "one" };
const OPTIONS = { prompt: "test> ", noun: "targets", items: [ITEM] };

for (const key of [CANCEL, ESCAPE, ENTER]) {
  test(`retains the frame until surface dismissal completes for ${JSON.stringify(key)}`, async () => {
    const terminal = new FakeTerminal([key]);
    const timers = new FakeTimers();
    let closed = false;
    await runTerminalPicker({
      ...OPTIONS, terminal, timers, refreshIntervalMilliseconds: INTERVAL_MS,
      reload: async () => ({ items: [] }),
      beforeCleanup: async () => {
        expect(terminal.writes.join("")).not.toContain(STOP_SCREEN);
        const writes = terminal.writes.length;
        timers.fire(INTERVAL_MS);
        await Promise.resolve();
        expect(terminal.writes).toHaveLength(writes);
        closed = true;
      },
    });
    expect(closed).toBe(true);
    expect(terminal.writes.at(-1)).toContain(STOP_SCREEN);
    expect(terminal.rawModes).toEqual([true, false]);
    expect(timers.activeCount()).toBe(0);
    expect(terminal.inputReturned).toBe(true);
  });
}

test("focus cancellation closes the surface before restoring the terminal", async () => {
  const terminal = new FakeTerminal([], VIEWPORT, true);
  const controller = new AbortController();
  let closed = false;
  const run = runTerminalPicker({
    ...OPTIONS, terminal, signal: controller.signal,
    beforeCleanup: async () => {
      expect(terminal.writes.join("")).not.toContain(STOP_SCREEN);
      closed = true;
    },
  });
  controller.abort();
  expect(await run).toBeUndefined();
  expect(closed).toBe(true);
  expect(terminal.rawModes).toEqual([true, false]);
  expect(terminal.writes.at(-1)).toContain(STOP_SCREEN);
});

test("surface close failure still restores every terminal resource", async () => {
  const terminal = new FakeTerminal([CANCEL]);
  const timers = new FakeTimers();
  await expect(runTerminalPicker({
    ...OPTIONS, terminal, timers, refreshIntervalMilliseconds: INTERVAL_MS,
    reload: async () => ({ items: [ITEM] }),
    beforeCleanup: async () => { throw FAILURE; },
  })).rejects.toBe(FAILURE);
  expect(terminal.rawModes).toEqual([true, false]);
  expect(terminal.writes.at(-1)).toContain(STOP_SCREEN);
  expect(timers.activeCount()).toBe(0);
  expect(terminal.inputReturned).toBe(true);
});

for (const mode of MODES) {
  test(`${mode} cancellation keeps the frame through its surface lifecycle`, async () => {
    const terminal = new FakeTerminal([CANCEL]);
    let closed = false;
    const herdr = new Herdr({ runner: async argv => ({
      stdout: argv.includes("workspace") ? WORKSPACES : AGENTS, stderr: "", exitCode: 0,
    }) });
    const result = await runPicker(mode, {
      herdr, env: {},
      beforeCleanup: async () => {
        expect(terminal.writes.join("")).not.toContain(STOP_SCREEN);
        closed = true;
      },
      pickerRunner: options => runTerminalPicker({ ...options, terminal }),
    });
    expect(result).toBe("cancelled");
    expect(closed).toBe(true);
    expect(terminal.writes.at(-1)).toContain(STOP_SCREEN);
  });
}
