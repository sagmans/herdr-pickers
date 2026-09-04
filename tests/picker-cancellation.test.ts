import { expect, test } from "bun:test";

import { Herdr, type CommandRunner } from "../src/client/herdr.ts";
import { runPicker, type PickerMode } from "../src/picker.ts";
import type { PickerItem } from "../src/picker-row.ts";
import { runTerminalPicker } from "../src/terminal-picker.ts";
import { FakeTerminal, VIEWPORT } from "./terminal-picker-test-support.ts";

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
        return rows.items[0];
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
      pickerRunner: async options => (options.loadOnStart ? await options.reload!() : options).items[0],
    });
    expect(outcome).toBe("dispatched");
    expect(order).toEqual(["stop", "dispatch"]);
  });
}
