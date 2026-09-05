import { expect, test } from "bun:test";

import { Herdr } from "../src/client/herdr.ts";
import { runPicker, type PickerMode } from "../src/picker.ts";
import { runTerminalPicker } from "../src/terminal-picker.ts";
import { FakeTerminal, FakeTimers, VIEWPORT } from "./terminal-picker-test-support.ts";

const STOP_SCREEN = "\x1b[?1049l";
const ENTER = "\r";
const MODES: PickerMode[] = ["workspaces", "agents"];
const WORKSPACES = JSON.stringify({ result: { workspaces: [{ workspace_id: "w1", label: "one" }] } });
const AGENTS = JSON.stringify({ result: { agents: [{ terminal_id: "t1", label: "pi", workspace_id: "w1" }] } });
const RESULT = JSON.stringify({ result: {} });
const FAILURE = new Error("dispatch failed");
const INTERVAL_MS = 1000;
const DEADLINE_MS = 100;
const TIMED_OUT = "timed-out";
const ITEM = { id: "one", target: "one", display: "one", searchText: "one" };
const OPTIONS = { prompt: "test> ", noun: "targets", items: [ITEM] };

for (const mode of MODES) {
  test(`${mode} preserves the selected frame through focus confirmation and dispatch`, async () => {
    const terminal = new FakeTerminal([ENTER]);
    let dispatched = false;
    const herdr = new Herdr({ runner: async argv => {
      if (argv.includes("focus")) {
        expect(terminal.writes.join("")).not.toContain(STOP_SCREEN);
        dispatched = true;
        return { stdout: RESULT, stderr: "", exitCode: 0 };
      }
      return { stdout: argv.includes("workspace") ? WORKSPACES : AGENTS, stderr: "", exitCode: 0 };
    }});
    const result = await runPicker(mode, {
      herdr, env: {},
      beforeDispatch: async () => { expect(terminal.writes.join("")).not.toContain(STOP_SCREEN); },
      pickerRunner: async options => {
        const rows = options.loadOnStart ? await options.reload!() : options;
        return runTerminalPicker({ ...options, ...rows, loadOnStart: false, terminal });
      },
    });
    expect(result).toBe("dispatched");
    expect(dispatched).toBe(true);
    expect(terminal.rawModes).toEqual([true, false]);
    expect(terminal.writes.at(-1)).toContain(STOP_SCREEN);
  });
}

test("acceptance freezes live refresh until handoff finishes", async () => {
  const terminal = new FakeTerminal([ENTER, ENTER]);
  const timers = new FakeTimers();
  let accepted = 0;
  let reloads = 0;
  const selection = await runTerminalPicker({
    ...OPTIONS, terminal, timers, refreshIntervalMilliseconds: INTERVAL_MS,
    reload: async () => { reloads++; return { items: [ITEM] }; },
    onAccept: async () => {
      accepted++;
      const writes = terminal.writes.length;
      timers.fire(INTERVAL_MS);
      await Promise.resolve();
      expect(terminal.writes).toHaveLength(writes);
      expect(terminal.writes.join("")).not.toContain(STOP_SCREEN);
    },
  });
  expect(selection).toEqual(ITEM);
  expect(accepted).toBe(1);
  expect(reloads).toBe(0);
  expect(timers.activeCount()).toBe(0);
});

test("rejected handoff restores terminal state", async () => {
  const terminal = new FakeTerminal([ENTER]);
  await expect(runTerminalPicker({ ...OPTIONS, terminal, onAccept: async () => { throw FAILURE; } })).rejects.toBe(FAILURE);
  expect(terminal.rawModes).toEqual([true, false]);
  expect(terminal.writes.at(-1)).toContain(STOP_SCREEN);
});

test("aborted handoff restores promptly without late output", async () => {
  const terminal = new FakeTerminal([ENTER], VIEWPORT, true);
  const controller = new AbortController();
  let finish!: () => void;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const run = runTerminalPicker({
    ...OPTIONS, terminal, signal: controller.signal,
    onAccept: () => { started(); return new Promise<void>(resolve => { finish = resolve; }); },
  });
  const phase = await Promise.race([ready.then(() => true), run.then(() => false)]);
  expect(phase).toBe(true);
  controller.abort();
  expect(await Promise.race([run, Bun.sleep(DEADLINE_MS).then(() => TIMED_OUT)])).toBeUndefined();
  const writes = terminal.writes.length;
  finish();
  await Promise.resolve();
  expect(terminal.writes).toHaveLength(writes);
  expect(terminal.rawModes).toEqual([true, false]);
});
