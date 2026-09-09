import { expect, test } from "bun:test";
import { PickerTerminal } from "../src/picker-terminal.ts";
import { runTerminalPicker } from "../src/terminal-picker.ts";
import { FakeTerminal, VIEWPORT } from "./terminal-picker-test-support.ts";

const START = "\x1b[?1049h";
const STOP = "\x1b[?1049l";
const ENTER = "\r";
const ESCAPE_PREFIX = "\x1b[";
const ARROW_TAIL = "B";
const ITEM = { id: "one", target: "one", display: "one", searchText: "one" };
const OPTIONS = { prompt: "picker> ", noun: "targets", items: [ITEM] };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test("replaces a mode with one terminal lifetime and one pending input read", async () => {
  const input = deferred<string>();
  const terminal = new FakeTerminal([input.promise]);
  const surface = new PickerTerminal(terminal);
  const first = new AbortController();
  const run = runTerminalPicker({ ...OPTIONS, ...surface.options(first.signal), signal: first.signal });
  first.abort();
  expect(await run).toBeUndefined();
  expect(terminal.writes.join("")).not.toContain(STOP);
  const next = runTerminalPicker({ ...OPTIONS, ...surface.options(), prompt: "worktrees> " });
  input.resolve(ENTER);
  expect(await next).toEqual(ITEM);
  expect(terminal.writes.filter(write => write.includes(START))).toHaveLength(1);
  expect(terminal.rawModes).toEqual([true]);
  surface.close();
  expect(terminal.rawModes).toEqual([true, false]);
  expect(terminal.writes.at(-1)).toContain(STOP);
});

test("does not replay buffered acceptance into the new mode", async () => {
  const oldInput = deferred<string>();
  const newInput = deferred<string>();
  const terminal = new FakeTerminal([oldInput.promise, newInput.promise]);
  const surface = new PickerTerminal(terminal);
  const first = new AbortController();
  const run = runTerminalPicker({ ...OPTIONS, ...surface.options(first.signal), signal: first.signal });
  first.abort();
  await run;
  oldInput.resolve(ENTER);
  await Bun.sleep(0);
  let accepted = false;
  const next = runTerminalPicker({ ...OPTIONS, ...surface.options(), onAccept: async () => { accepted = true; } });
  await Bun.sleep(0);
  expect(accepted).toBe(false);
  newInput.resolve(ENTER);
  await next;
  expect(accepted).toBe(true);
  surface.close();
});

test("discarded fragmented keys cannot become new search text", async () => {
  const tail = deferred<string>();
  const finish = deferred<string>();
  const terminal = new FakeTerminal([ESCAPE_PREFIX, tail.promise, finish.promise], VIEWPORT);
  const surface = new PickerTerminal(terminal);
  const first = new AbortController();
  const run = runTerminalPicker({ ...OPTIONS, ...surface.options(first.signal), signal: first.signal });
  await Bun.sleep(0);
  first.abort();
  await run;
  const queries: string[] = [];
  const next = runTerminalPicker({ ...OPTIONS, ...surface.options(), ranker: async query => { queries.push(query); return [ITEM]; } });
  tail.resolve(ARROW_TAIL);
  await Bun.sleep(0);
  finish.resolve(ENTER);
  await next;
  expect(queries).toEqual([]);
  surface.close();
});
