import { expect, test } from "bun:test";

import { Herdr } from "../src/client/herdr.ts";
import { DEFAULT_PICKER_KEYMAP, type HerdrPickersConfig } from "../src/config/config.ts";
import type { PickerMode } from "../src/modes.ts";
import { runPicker } from "../src/picker.ts";
import { FakeTerminal, FakeTimers, VIEWPORT, runAdapterPicker } from "./terminal-picker-test-support.ts";

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
const CONFIG: HerdrPickersConfig = { placement: "popup", keymap: DEFAULT_PICKER_KEYMAP, projects: { roots: [] } };
const SIGNAL = new AbortController().signal;

for (const key of [CANCEL, ESCAPE, ENTER]) {
  test(`retains the frame until surface dismissal completes for ${JSON.stringify(key)}`, async () => {
    const terminal = new FakeTerminal([key]);
    const timers = new FakeTimers();
    let closed = false;
    await runAdapterPicker({
      ...OPTIONS, terminal, timers, refreshIntervalMilliseconds: INTERVAL_MS,
      reload: async () => ({ items: [] }),
      dismiss: async () => {
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
  const run = runAdapterPicker({
    ...OPTIONS, terminal, signal: controller.signal,
    dismiss: async () => {
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
  await expect(runAdapterPicker({
    ...OPTIONS, terminal, timers, refreshIntervalMilliseconds: INTERVAL_MS,
    reload: async () => ({ items: [ITEM] }),
    dismiss: async () => { throw FAILURE; },
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
      herdr, signal: SIGNAL, context: {}, config: CONFIG,
      pickerRunner: options => runAdapterPicker({
        ...options, terminal,
        dismiss: async () => {
          expect(terminal.writes.join("")).not.toContain(STOP_SCREEN);
          closed = true;
        },
      }),
    });
    expect(result).toBe("cancelled");
    expect(closed).toBe(true);
    expect(terminal.writes.at(-1)).toContain(STOP_SCREEN);
  });
}
