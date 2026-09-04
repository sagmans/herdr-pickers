import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { getEventListeners } from "node:events";
import { afterEach, describe, expect, test } from "bun:test";

import { Herdr, HerdrCommandError, type CommandResult, type CommandRunner } from "../src/client/herdr.ts";
import {
  listGitWorktrees,
  listWorktreesForContext,
  listWorktreesForProject,
  listWorktreesForProjects,
} from "../src/discovery/worktrees.ts";
import { rankRows } from "../src/fzf.ts";
import type { PickerItem } from "../src/picker-row.ts";

const ABORT_EVENT = "abort";
const BLOCKING_MILLISECONDS = 1_500;
const CHECK_INTERVAL_MILLISECONDS = 10;
const COMMAND_MODE = 0o700;
const FAILURE_RESULT: CommandResult = { stdout: "", stderr: "unavailable", exitCode: 1 };
const FZF_BLOCKING_PAYLOAD_LENGTH = 2_000_000;
const FZF_COMMAND = "fzf";
const FZF_OUTPUT_PAYLOAD_LENGTH = 0;
const GIT_COMMAND = "git";
const FZF_MODULE_URL = new URL("../src/fzf.ts", import.meta.url).href;
const HERDR_MODULE_URL = new URL("../src/client/herdr.ts", import.meta.url).href;
const LOCAL_COMMAND_PREFIX = "/tmp/herdr-pickers-cancellation-";
const PROBE_FILE_NAME = "probe.ts";
const temporaryDirectories: string[] = [];
const PATH_ENVIRONMENT_KEY = "PATH";
const PROJECT_PATH = "/repo/project";
const SETTLE_TIMEOUT_MILLISECONDS = 1_000;
const TEST_TIMEOUT_MILLISECONDS = 5_000;
const WORKTREES_MODULE_URL = new URL("../src/discovery/worktrees.ts", import.meta.url).href;

function temporaryDirectory(): string {
  const directory = mkdtempSync(LOCAL_COMMAND_PREFIX);
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function pickerItem(searchText: string): PickerItem {
  return { id: "target", searchText, display: searchText, target: "target" };
}

function createLocalCommand(name: string, markerPath: string, blocking: boolean): string {
  const directory = temporaryDirectory();
  const commandPath = join(directory, name);
  const wait = blocking ? `setTimeout(() => process.exit(0), ${BLOCKING_MILLISECONDS});` : "";
  writeFileSync(commandPath, [
    "#!/usr/bin/env bun",
    'import { writeFileSync } from "node:fs";',
    `writeFileSync(${JSON.stringify(markerPath)}, String(process.pid));`,
    wait,
  ].join("\n"), { encoding: "utf8", mode: COMMAND_MODE });
  return commandPath;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + SETTLE_TIMEOUT_MILLISECONDS;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for subprocess state");
    await Bun.sleep(CHECK_INTERVAL_MILLISECONDS);
  }
}

async function caughtFrom(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected operation to reject");
}

async function settleWithin<T>(promise: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error("operation did not settle after abort")), SETTLE_TIMEOUT_MILLISECONDS);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function runWithStartupPath(commandPath: string, source: string): Promise<CommandResult> {
  const path = `${dirname(commandPath)}${delimiter}${process.env[PATH_ENVIRONMENT_KEY] ?? ""}`;
  const scriptPath = join(temporaryDirectory(), PROBE_FILE_NAME);
  writeFileSync(scriptPath, source, "utf8");
  const proc = Bun.spawn([process.execPath, scriptPath], {
    env: { ...process.env, [PATH_ENVIRONMENT_KEY]: path },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe.serial("subprocess cancellation", () => {
  test("Herdr passes its signal to an injected runner", async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const runner: CommandRunner = async (_argv, signal) => {
      receivedSignal = signal;
      return { stdout: "ok", stderr: "", exitCode: 0 };
    };

    await new Herdr({ runner, signal: controller.signal }).run(["workspace", "list"]);

    expect(receivedSignal).toBe(controller.signal);
  });

  test("pre-aborted Herdr does not invoke an injected runner", async () => {
    const controller = new AbortController();
    let calls = 0;
    const runner: CommandRunner = async () => {
      calls += 1;
      return { stdout: "ok", stderr: "", exitCode: 0 };
    };
    controller.abort();

    const error = await caughtFrom(new Herdr({ runner, signal: controller.signal }).run(["workspace", "list"]));

    expect(error).toBe(controller.signal.reason);
    expect(calls).toBe(0);
  });

  test("Herdr preserves abort when an injected runner rejects", async () => {
    const controller = new AbortController();
    let runnerStarted = false;
    const herdr = new Herdr({
      signal: controller.signal,
      runner: async (_argv, signal) => {
        runnerStarted = true;
        await new Promise<void>((resolve) => signal?.addEventListener(ABORT_EVENT, () => resolve(), { once: true }));
        throw new HerdrCommandError(["workspace", "list"], FAILURE_RESULT.exitCode, FAILURE_RESULT.stderr);
      },
    });
    const running = herdr.run(["workspace", "list"]);
    await waitFor(() => runnerStarted);

    controller.abort();
    const error = await settleWithin(caughtFrom(running));

    expect(error).toBe(controller.signal.reason);
    expect(error).not.toBeInstanceOf(HerdrCommandError);
  });

  test("Herdr cancels its built-in subprocess without wrapping the abort", async () => {
    const directory = temporaryDirectory();
    const markerPath = join(directory, "herdr-started");
    const commandPath = createLocalCommand("blocking-herdr", markerPath, true);
    const controller = new AbortController();
    const baselineListeners = getEventListeners(controller.signal, ABORT_EVENT).length;
    const running = new Herdr({ bin: commandPath, signal: controller.signal }).run(["workspace", "list"]);
    await waitFor(() => existsSync(markerPath));
    const pid = Number(readFileSync(markerPath, "utf8"));

    controller.abort();
    const error = await settleWithin(caughtFrom(running));

    expect(error).toBe(controller.signal.reason);
    expect(error).not.toBeInstanceOf(HerdrCommandError);
    await waitFor(() => !processIsRunning(pid));
    expect(getEventListeners(controller.signal, ABORT_EVENT)).toHaveLength(baselineListeners);
  }, TEST_TIMEOUT_MILLISECONDS);

  test("pre-aborted fzf ranking rejects before work starts", async () => {
    const controller = new AbortController();
    controller.abort();

    const error = await caughtFrom(rankRows("query", [pickerItem("query")], controller.signal));

    expect(error).toBe(controller.signal.reason);
  });

  for (const [waitName, payloadLength] of [
    ["output", FZF_OUTPUT_PAYLOAD_LENGTH],
    ["input flush", FZF_BLOCKING_PAYLOAD_LENGTH],
  ] as const) {
    test(`fzf cancellation settles blocked ${waitName} waits`, async () => {
      const directory = temporaryDirectory();
      const markerPath = join(directory, "fzf-started");
      const commandPath = createLocalCommand(FZF_COMMAND, markerPath, true);
      const source = `
        import { existsSync } from "node:fs";
        import { getEventListeners } from "node:events";
        import { rankRows } from ${JSON.stringify(FZF_MODULE_URL)};
        const controller = new AbortController();
        const baseline = getEventListeners(controller.signal, ${JSON.stringify(ABORT_EVENT)}).length;
        const item = {
          id: "target",
          searchText: "query" + "x".repeat(${payloadLength}),
          display: "query",
          target: "target",
        };
        const running = rankRows("query", [item], controller.signal);
        const deadline = Date.now() + ${SETTLE_TIMEOUT_MILLISECONDS};
        while (!existsSync(${JSON.stringify(markerPath)})) {
          if (Date.now() >= deadline) throw new Error("fzf did not start");
          await Bun.sleep(${CHECK_INTERVAL_MILLISECONDS});
        }
        controller.abort();
        let caught;
        try { await running; } catch (error) { caught = error; }
        if (caught !== controller.signal.reason) throw new Error("fzf did not preserve the abort reason");
        if (getEventListeners(controller.signal, ${JSON.stringify(ABORT_EVENT)}).length !== baseline) {
          throw new Error("fzf retained an abort listener");
        }
      `;

      const result = await runWithStartupPath(commandPath, source);

      expect(result).toEqual({ stdout: "", stderr: "", exitCode: 0 });
      const pid = Number(readFileSync(markerPath, "utf8"));
      await waitFor(() => !processIsRunning(pid));
    }, TEST_TIMEOUT_MILLISECONDS);
  }

  test("worktree discovery passes the final signal to injected Git runners", async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const gitRunner: CommandRunner = async (_argv, signal) => {
      receivedSignal = signal;
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    const herdr = new Herdr({ runner: async () => FAILURE_RESULT });

    await listWorktreesForProjects([PROJECT_PATH], herdr, gitRunner, controller.signal);

    expect(receivedSignal).toBe(controller.signal);
  });

  test("worktree discovery preserves abort from an injected Git runner", async () => {
    const controller = new AbortController();
    let runnerStarted = false;
    const runner: CommandRunner = async (_argv, signal) => {
      runnerStarted = true;
      await new Promise<void>((resolve) => signal?.addEventListener(ABORT_EVENT, () => resolve(), { once: true }));
      throw new Error("Git runner stopped");
    };
    const running = listGitWorktrees(PROJECT_PATH, runner, controller.signal);
    await waitFor(() => runnerStarted);

    controller.abort();
    const error = await settleWithin(caughtFrom(running));

    expect(error).toBe(controller.signal.reason);
  });

  test("pre-aborted worktree discovery does not invoke Herdr or Git", async () => {
    const controller = new AbortController();
    let calls = 0;
    const runner: CommandRunner = async () => {
      calls += 1;
      return FAILURE_RESULT;
    };
    const herdr = new Herdr({ runner });
    controller.abort();

    const contextError = await caughtFrom(listWorktreesForContext({ cwd: PROJECT_PATH }, herdr, controller.signal));
    const gitError = await caughtFrom(listGitWorktrees(PROJECT_PATH, runner, controller.signal));

    expect(contextError).toBe(controller.signal.reason);
    expect(gitError).toBe(controller.signal.reason);
    expect(calls).toBe(0);
  });

  test("Herdr abort does not trigger the worktree Git fallback", async () => {
    const controller = new AbortController();
    let herdrStarted = false;
    let gitCalls = 0;
    const herdr = new Herdr({
      signal: controller.signal,
      runner: async (_argv, signal) => {
        herdrStarted = true;
        await new Promise<void>((resolve) => signal?.addEventListener(ABORT_EVENT, () => resolve(), { once: true }));
        return FAILURE_RESULT;
      },
    });
    const gitRunner: CommandRunner = async () => {
      gitCalls += 1;
      return FAILURE_RESULT;
    };
    const running = listWorktreesForProject(PROJECT_PATH, herdr, gitRunner, controller.signal);
    await waitFor(() => herdrStarted);

    controller.abort();
    const error = await settleWithin(caughtFrom(running));

    expect(error).toBe(controller.signal.reason);
    expect(error).not.toBeInstanceOf(HerdrCommandError);
    expect(gitCalls).toBe(0);
  });

  test("worktree discovery cancels its built-in Git subprocess", async () => {
    const directory = temporaryDirectory();
    const markerPath = join(directory, "git-started");
    const commandPath = createLocalCommand(GIT_COMMAND, markerPath, true);
    const source = `
      import { existsSync } from "node:fs";
      import { getEventListeners } from "node:events";
      import { Herdr } from ${JSON.stringify(HERDR_MODULE_URL)};
      import { listWorktreesForProject } from ${JSON.stringify(WORKTREES_MODULE_URL)};
      const controller = new AbortController();
      const baseline = getEventListeners(controller.signal, ${JSON.stringify(ABORT_EVENT)}).length;
      const herdr = new Herdr({ runner: async () => (${JSON.stringify(FAILURE_RESULT)}) });
      const running = listWorktreesForProject(${JSON.stringify(PROJECT_PATH)}, herdr, undefined, controller.signal);
      const deadline = Date.now() + ${SETTLE_TIMEOUT_MILLISECONDS};
      while (!existsSync(${JSON.stringify(markerPath)})) {
        if (Date.now() >= deadline) throw new Error("Git did not start");
        await Bun.sleep(${CHECK_INTERVAL_MILLISECONDS});
      }
      controller.abort();
      let caught;
      try { await running; } catch (error) { caught = error; }
      if (caught !== controller.signal.reason) throw new Error("Git did not preserve the abort reason");
      if (getEventListeners(controller.signal, ${JSON.stringify(ABORT_EVENT)}).length !== baseline) {
        throw new Error("Git retained an abort listener");
      }
    `;

    const result = await runWithStartupPath(commandPath, source);

    expect(result).toEqual({ stdout: "", stderr: "", exitCode: 0 });
    const pid = Number(readFileSync(markerPath, "utf8"));
    await waitFor(() => !processIsRunning(pid));
  }, TEST_TIMEOUT_MILLISECONDS);
});
