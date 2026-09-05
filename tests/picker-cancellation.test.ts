import { expect, test } from "bun:test";

import { Herdr, type CommandRunner } from "../src/client/herdr.ts";
import { runPicker, type PickerMode } from "../src/picker.ts";
import type { PickerItem } from "../src/picker-row.ts";
import { runTerminalPicker } from "../src/terminal-picker.ts";
import { FakeTerminal, FakeTimers, VIEWPORT } from "./terminal-picker-test-support.ts";

const DEADLINE_MS = 100;
const TIMED_OUT = "timed-out";
const STOP_SCREEN = "\x1b[?1049l";
const PROMPT = "test> ";
const NOUN = "targets";
const ITEMS: PickerItem[] = [{ id: "one", target: "one", searchText: "one", display: "one" }];
const WORKSPACES = JSON.stringify({ result: { workspaces: [{ workspace_id: "w1", label: "one" }] } });
const AGENTS = JSON.stringify({ result: { agents: [{ terminal_id: "t1", label: "pi", workspace_id: "w1" }] } });
const RESULT = JSON.stringify({ result: {} });
const MODES: PickerMode[] = ["workspaces", "agents"];
const RELOAD_KEY = "\x12";
const REFRESH_INTERVAL_MS = 1000;
const LOAD_PHASES = [true, false] as const;

test("pre-aborted terminal never enters raw mode", async () => {
  const controller = new AbortController();
  controller.abort();
  const terminal = new FakeTerminal([]);
  expect(await runTerminalPicker({ prompt: PROMPT, noun: NOUN, items: ITEMS, terminal, signal: controller.signal })).toBeUndefined();
  expect(terminal.rawModes).toEqual([]);
  expect(terminal.writes).toEqual([]);
});

test("focus cancellation wakes pending input and restores terminal", async () => {
  const controller = new AbortController();
  const terminal = new FakeTerminal([], VIEWPORT, true);
  const run = runTerminalPicker({ prompt: PROMPT, noun: NOUN, items: ITEMS, terminal, signal: controller.signal });
  controller.abort();
  const result = await Promise.race([run, Bun.sleep(DEADLINE_MS).then(() => TIMED_OUT)]);
  terminal.finish();
  await run;
  expect(result).toBeUndefined();
  expect(terminal.rawModes).toEqual([true, false]);
  expect(terminal.writes.at(-1)).toContain(STOP_SCREEN);
  expect(terminal.inputReturned).toBe(true);
});

test("focus cancellation interrupts ranking and discards late output", async () => {
  const controller = new AbortController();
  const terminal = new FakeTerminal(["o"], VIEWPORT, true);
  let resolveRank!: (items: PickerItem[]) => void;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const run = runTerminalPicker({
    prompt: PROMPT, noun: NOUN, items: ITEMS, terminal, signal: controller.signal,
    ranker: () => { started(); return new Promise(resolve => { resolveRank = resolve; }); },
  });
  await ready;
  controller.abort();
  const result = await Promise.race([run, Bun.sleep(DEADLINE_MS).then(() => TIMED_OUT)]);
  const writes = terminal.writes.length;
  resolveRank(ITEMS);
  await Promise.resolve();
  terminal.finish();
  if (result === TIMED_OUT) { controller.abort(); return expect(result).toBeUndefined(); }
  await run;
  expect(result).toBeUndefined();
  expect(terminal.writes).toHaveLength(writes);
  expect(terminal.rawModes).toEqual([true, false]);
});

for (const loadOnStart of LOAD_PHASES) {
  test(`cancels ${loadOnStart ? "initial loading" : "manual reload"} without late redraws`, async () => {
    const controller = new AbortController();
    const terminal = new FakeTerminal(loadOnStart ? [] : [RELOAD_KEY], VIEWPORT, true);
    const timers = new FakeTimers();
    let started!: () => void;
    let finish!: (rows: { items: PickerItem[] }) => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const run = runTerminalPicker({
      prompt: PROMPT, noun: NOUN, items: ITEMS, terminal, timers, signal: controller.signal, loadOnStart,
      refreshIntervalMilliseconds: REFRESH_INTERVAL_MS,
      reload: () => { started(); return new Promise(resolve => { finish = resolve; }); },
    });
    await ready;
    controller.abort();
    expect(await Promise.race([run, Bun.sleep(DEADLINE_MS).then(() => TIMED_OUT)])).toBeUndefined();
    const writes = terminal.writes.length;
    finish({ items: ITEMS });
    await Promise.resolve();
    await run;
    expect(terminal.writes).toHaveLength(writes);
    expect(timers.activeCount()).toBe(0);
    expect(terminal.rawModes).toEqual([true, false]);
  });
}

for (const mode of MODES) {
  test(`${mode} cancellation suppresses a late accepted selection`, async () => {
    const controller = new AbortController();
    const focused: string[][] = [];
    const runner: CommandRunner = async argv => {
      if (argv.includes("focus")) focused.push([...argv]);
      return { stdout: argv.includes("workspace") ? WORKSPACES : AGENTS, stderr: "", exitCode: 0 };
    };
    const outcome = await runPicker(mode, {
      herdr: new Herdr({ runner }), env: {}, signal: controller.signal,
      pickerRunner: async options => {
        const rows = options.loadOnStart ? await options.reload!() : options;
        controller.abort();
        const selection = rows.items[0];
        if (selection) await options.onAccept?.(selection);
        return selection;
      },
    });
    expect(outcome).toBe("cancelled");
    expect(focused).toEqual([]);
  });

  test(`${mode} waits for focus confirmation before dispatch`, async () => {
    const controller = new AbortController();
    const focused: string[][] = [];
    const runner: CommandRunner = async argv => {
      if (argv.includes("focus")) focused.push([...argv]);
      return { stdout: argv.includes("workspace") ? WORKSPACES : AGENTS, stderr: "", exitCode: 0 };
    };
    const outcome = await runPicker(mode, {
      herdr: new Herdr({ runner }), env: {}, signal: controller.signal,
      beforeDispatch: async () => { await Promise.resolve(); controller.abort(); },
      pickerRunner: async options => {
        const selection = (options.loadOnStart ? await options.reload!() : options).items[0];
        if (selection) await options.onAccept?.(selection);
        return selection;
      },
    });
    expect(outcome).toBe("cancelled");
    expect(focused).toEqual([]);
  });

  test(`${mode} stops focus observation before dispatch`, async () => {
    const order: string[] = [];
    const runner: CommandRunner = async argv => {
      if (argv.includes("focus")) { order.push("dispatch"); return { stdout: RESULT, stderr: "", exitCode: 0 }; }
      return { stdout: argv.includes("workspace") ? WORKSPACES : AGENTS, stderr: "", exitCode: 0 };
    };
    const outcome = await runPicker(mode, {
      herdr: new Herdr({ runner }), env: {}, beforeDispatch: () => { order.push("stop"); },
      pickerRunner: async options => {
        const selection = (options.loadOnStart ? await options.reload!() : options).items[0];
        if (selection) await options.onAccept?.(selection);
        return selection;
      },
    });
    expect(outcome).toBe("dispatched");
    expect(order).toEqual(["stop", "dispatch"]);
  });
}
