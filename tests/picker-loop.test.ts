import { expect, test } from "bun:test";
import { Herdr } from "../src/client/herdr.ts";
import { runPickerLoop } from "../src/picker-loop.ts";
import { runTerminalPicker } from "../src/terminal-picker.ts";
import type { PickerRequest } from "../src/picker-request.ts";
import { FakeTerminal, VIEWPORT } from "./terminal-picker-test-support.ts";

const OWNER = "owner";
const ENTER = "\r";
const STOP = "\x1b[?1049l";
const WORKSPACES = JSON.stringify({ result: { workspaces: [{ workspace_id: "w1", label: "one" }] } });
const AGENTS = JSON.stringify({ result: { agents: [{ terminal_id: "t1", label: "pi", workspace_id: "w1" }] } });
const OK = JSON.stringify({ result: {} });
const FIRST: PickerRequest = { token: "first", mode: "workspaces", context: { cwd: "/source" }, acknowledgedBy: null };
const SECOND: PickerRequest = { ...FIRST, token: "second", mode: "agents" };
const WAIT_LIMIT_MS = 1_000;
const POLL_MS = 1;
const QUERY = "old-query";
const RELOAD = "\u0012";
const CLOSE = "\u0003";
const OLD_FAILURE = new Error("obsolete operation failed");
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
async function until(probe: () => boolean): Promise<void> {
  const deadline = Date.now() + WAIT_LIMIT_MS;
  while (!probe()) {
    if (Date.now() >= deadline) throw new Error("condition timed out");
    await Bun.sleep(POLL_MS);
  }
}
function mailbox() {
  let request = FIRST;
  const acknowledgements: string[] = [];
  return {
    latestRequest: () => request,
    acknowledge: (token: string, owner: string) => {
      expect(owner).toBe(OWNER);
      if (token !== request.token) return false;
      acknowledgements.push(token);
      return true;
    },
    replace: (next = SECOND) => { request = next; }, acknowledgements,
  };
}

test("replacement interrupts discovery and reuses the surface without stale output", async () => {
  const session = mailbox();
  const firstLoad = deferred<string>();
  const input = deferred<string>();
  const terminal = new FakeTerminal([input.promise], VIEWPORT, true);
  let loads = 0;
  const dispatched: string[][] = [];
  const run = runPickerLoop(session, OWNER, {
    env: {}, terminal,
    createRuntime: signal => ({ herdr: new Herdr({ signal, runner: async argv => {
      if (argv.includes("focus")) { dispatched.push([...argv]); return { stdout: OK, stderr: "", exitCode: 0 }; }
      const stdout = ++loads === 1 ? await firstLoad.promise : argv.includes("agent") ? AGENTS : WORKSPACES;
      return { stdout, stderr: "", exitCode: 0 };
    } }) }),
  });
  await until(() => loads > 0);
  session.replace();
  await until(() => terminal.writes.some(write => write.includes("agents ›")));
  expect(terminal.writes.join("")).not.toContain(STOP);
  input.resolve(ENTER);
  expect(await run).toBe("dispatched");
  expect(session.acknowledgements).toEqual([FIRST.token, SECOND.token]);
  expect(dispatched).toHaveLength(1);
  expect(dispatched[0]).toContain("agent");
  const writes = terminal.writes.length;
  firstLoad.resolve(WORKSPACES);
  await Bun.sleep(POLL_MS);
  expect(terminal.writes).toHaveLength(writes);
  expect(terminal.rawModes).toEqual([true, false]);
});

for (const operation of ["ranking", "refresh"] as const) {
  test(`replacement interrupts ${operation} and ignores its late error`, async () => {
    const session = mailbox();
    const obsolete = deferred<string>();
    const oldInput = deferred<string>();
    const newInput = deferred<string>();
    const terminal = new FakeTerminal([oldInput.promise, newInput.promise], VIEWPORT, true);
    const signals: AbortSignal[] = [];
    let blocked = false;
    let loads = 0;
    const run = runPickerLoop(session, OWNER, {
      env: {}, terminal,
      createRuntime: signal => {
        signals.push(signal);
        return {
          herdr: new Herdr({ signal, runner: async argv => {
            if (operation === "refresh" && signals.length === 1 && ++loads > 1) {
              blocked = true;
              await obsolete.promise;
            }
            return { stdout: argv.includes("agent") ? AGENTS : WORKSPACES, stderr: "", exitCode: 0 };
          } }),
          pickerRunner: options => runTerminalPicker({ ...options, ranker: async (query, items) => {
            if (query === QUERY) { blocked = true; await obsolete.promise; }
            return [...items];
          } }),
        };
      },
    });
    await until(() => terminal.writes.some(write => write.includes("one")));
    oldInput.resolve(operation === "ranking" ? QUERY : RELOAD);
    await until(() => blocked);
    session.replace();
    await until(() => terminal.writes.some(write => write.includes("agents ›")));
    expect(signals[0]?.aborted).toBe(true);
    const writes = terminal.writes.length;
    obsolete.reject(OLD_FAILURE);
    await Bun.sleep(POLL_MS);
    expect(terminal.writes).toHaveLength(writes);
    expect(terminal.writes.join("")).not.toContain(STOP);
    newInput.resolve(ENTER);
    expect(await run).toBe("dispatched");
    expect(terminal.rawModes).toEqual([true, false]);
  });
}

test("requests after dispatch submission remain unacknowledged for a successor", async () => {
  const session = mailbox();
  const submission = deferred<string>();
  const input = deferred<string>();
  const terminal = new FakeTerminal([input.promise], VIEWPORT, true);
  let submitted = false;
  const run = runPickerLoop(session, OWNER, {
    env: {}, terminal,
    createRuntime: signal => ({ herdr: new Herdr({ signal, runner: async argv => {
      if (argv.includes("focus")) { submitted = true; await submission.promise; }
      return { stdout: WORKSPACES, stderr: "", exitCode: 0 };
    } }) }),
  });
  await until(() => terminal.writes.some(write => write.includes("one")));
  input.resolve(ENTER);
  await until(() => submitted);
  session.replace();
  submission.resolve(OK);
  expect(await run).toBe("dispatched");
  expect(session.latestRequest()).toBe(SECOND);
  expect(session.acknowledgements).toEqual([FIRST.token]);
  expect(terminal.rawModes).toEqual([true, false]);
});

test("replacement failure closes once and restores the shared terminal", async () => {
  const session = mailbox();
  const terminal = new FakeTerminal([], VIEWPORT, true);
  let closed = 0;
  const run = runPickerLoop(session, OWNER, {
    env: {}, terminal,
    beforeCleanup: async () => { closed++; },
    createRuntime: signal => ({ herdr: new Herdr({ signal, runner: async argv => {
      if (argv.includes("agent")) throw OLD_FAILURE;
      return { stdout: WORKSPACES, stderr: "", exitCode: 0 };
    } }) }),
  });
  const outcome = run.then(() => undefined, error => error);
  await until(() => terminal.writes.some(write => write.includes("one")));
  session.replace();
  expect(await outcome).toBe(OLD_FAILURE);
  expect(closed).toBe(1);
  expect(terminal.rawModes).toEqual([true, false]);
  expect(terminal.writes.filter(write => write.includes(STOP))).toHaveLength(1);
});

test("repeating a mode resets the query and terminal cancellation still closes", async () => {
  const session = mailbox();
  const oldInput = deferred<string>();
  const newInput = deferred<string>();
  const terminal = new FakeTerminal([oldInput.promise, newInput.promise], VIEWPORT, true);
  const run = runPickerLoop(session, OWNER, {
    env: {}, terminal,
    createRuntime: signal => ({ herdr: new Herdr({ signal, runner: async () => ({ stdout: WORKSPACES, stderr: "", exitCode: 0 }) }) }),
  });
  await until(() => terminal.writes.some(write => write.includes("one")));
  oldInput.resolve(QUERY);
  await until(() => terminal.writes.some(write => write.includes(QUERY)));
  const offset = terminal.writes.length;
  session.replace({ ...SECOND, mode: FIRST.mode });
  await until(() => terminal.writes.length > offset);
  expect(terminal.writes.slice(offset).join("")).not.toContain(QUERY);
  newInput.resolve(CLOSE);
  expect(await run).toBe("cancelled");
  expect(terminal.rawModes).toEqual([true, false]);
});

test("replacement during focus confirmation cannot dispatch an old selection", async () => {
  const session = mailbox();
  const input = deferred<string>();
  const confirmation = deferred<void>();
  const terminal = new FakeTerminal([ENTER, input.promise], VIEWPORT, true);
  let confirming = false;
  const dispatched: string[][] = [];
  const run = runPickerLoop(session, OWNER, {
    env: {}, terminal,
    createRuntime: signal => ({
      herdr: new Herdr({ signal, runner: async argv => {
        if (argv.includes("focus")) dispatched.push([...argv]);
        return { stdout: argv.includes("agent") ? AGENTS : WORKSPACES, stderr: "", exitCode: 0 };
      } }),
      beforeDispatch: async () => { if (!confirming) { confirming = true; await confirmation.promise; } },
      pickerRunner: async options => {
        const rows = options.loadOnStart ? await options.reload!() : options;
        return runTerminalPicker({ ...options, ...rows, loadOnStart: false });
      },
    }),
  });
  await until(() => confirming);
  session.replace();
  await until(() => terminal.writes.some(write => write.includes("agents ›")));
  confirmation.resolve();
  await Bun.sleep(POLL_MS);
  expect(dispatched).toEqual([]);
  input.resolve(ENTER);
  expect(await run).toBe("dispatched");
  expect(dispatched).toHaveLength(1);
  expect(dispatched[0]).toContain("agent");
});
