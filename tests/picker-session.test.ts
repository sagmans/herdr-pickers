import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";

import { PickerSession } from "../src/picker-session.ts";
import { buildPaneOpenArgs, openPicker } from "../src/actions/open.ts";
import { Herdr } from "../src/client/herdr.ts";
import { readPickerPaneIds } from "../src/client/types.ts";

const TEMP_PREFIX = "/tmp/hps-owner-";
const SOCKET_NAME = "herdr.sock";
const SECOND_SOCKET_NAME = "other.sock";
const PANE_ID = "w1:p2";
const STALE_TOKEN = "stale-generation";
const WORKER_PATH = join(import.meta.dir, "fixtures", "picker-session-worker.ts");
const WORKER_COUNT = 6;
const PLUGIN_ID = "herdr-pickers";
const OPEN_RESULT = JSON.stringify({ result: { type: "ok" } });
const ALIAS_NAME = "alias";
const DATABASE_NAME = "picker-sessions.sqlite";
const SENTINEL_NAME = "sentinel";
const SENTINEL_CONTENT = "must remain unchanged";
const REQUEST_MODE = "request";
const DEADLINE_PROBE_MS = 4_000;
const DEADLINE_NOT_ENFORCED = "deadline not enforced";
const MAX_TEST_CONTEXT = 64 * 1024;
const LATE_CLAIM_MS = 50;
const OPEN_ACTION_PATH = join(import.meta.dir, "../src/actions/open.ts");
const MISSING_BINARY = "missing-herdr";
const workers: Bun.Subprocess<"pipe", "pipe", "pipe">[] = [];
const roots: string[] = [];
const servers: Server[] = [];
const sessions: PickerSession[] = [];

afterEach(async () => {
  for (const worker of workers.splice(0)) { worker.kill(); await worker.exited; }
  for (const session of sessions.splice(0)) session.close();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture() {
  const root = mkdtempSync(TEMP_PREFIX);
  roots.push(root);
  const socketPath = join(root, SOCKET_NAME);
  const server = createServer();
  servers.push(server);
  await new Promise<void>(resolve => server.listen(socketPath, resolve));
  const env = { HERDR_PLUGIN_STATE_DIR: root, HERDR_SOCKET_PATH: socketPath };
  const session = new PickerSession(env);
  sessions.push(session);
  return { root, env, session };
}

test("shared action entrypoint forwards replacement to the live owner", async () => {
  const { env, root, session } = await fixture();
  const commands: string[][] = [];
  let owner!: string;
  const herdr = new Herdr({ runner: async argv => {
    commands.push([...argv]);
    owner = argv.find(value => value.startsWith("HERDR_PICKERS_SESSION_TOKEN="))!.split("=")[1]!;
    session.claim(owner);
    session.acknowledge(session.latestRequest()!.token, owner);
    return { stdout: OPEN_RESULT, stderr: "", exitCode: 0 };
  } });
  const actionEnv = { ...env, HERDR_PLUGIN_CONFIG_DIR: root, HERDR_PLUGIN_ID: PLUGIN_ID };
  await openPicker("workspaces", actionEnv, herdr);
  const replacement = openPicker("agents", actionEnv, herdr);
  expect(session.latestRequest()?.mode).toBe("agents");
  session.acknowledge(session.latestRequest()!.token, owner);
  await replacement;
  expect(commands).toHaveLength(1);
  expect(commands[0]?.some(value => value.startsWith("HERDR_PICKERS_SESSION_TOKEN="))).toBe(true);
});

test("a real pre-submission spawn failure permits a new owner in another process", async () => {
  const { env, root } = await fixture();
  const action = Bun.spawn([process.execPath, OPEN_ACTION_PATH, "workspaces"], {
    env: { ...env, HERDR_PLUGIN_CONFIG_DIR: root, HERDR_PLUGIN_ID: PLUGIN_ID, HERDR_BIN_PATH: join(root, MISSING_BINARY) },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  workers.push(action);
  expect(await action.exited).toBe(1);
  const next = await worker(env);
  expect(next.token).toBeString();
});

test("new requests replace the mailbox and reject stale acknowledgements", async () => {
  const { session } = await fixture();
  const owner = await session.reserve("overlay", async () => false);
  session.claim(owner!, PANE_ID);
  const first = session.request("agents", { paneId: "w1:p1", cwd: "/source" });
  const latest = session.request("worktrees", { paneId: PANE_ID, cwd: "/plugin" });
  expect(session.latestRequest()?.token).toBe(latest.token);
  expect(session.latestRequest()?.context).toEqual(first.context);
  expect(session.acknowledge(first.token, owner!)).toBe(false);
  expect(session.acknowledge(latest.token, STALE_TOKEN)).toBe(false);
  expect(session.acknowledge(latest.token, owner!)).toBe(true);
  expect(session.latestRequest()?.acknowledgedBy).toBe(owner);
  const repeat = session.request("worktrees", { paneId: PANE_ID });
  expect(repeat.token).not.toBe(latest.token);
  expect(repeat.acknowledgedBy).toBeNull();
});

test("request storage is bounded and keeps genuine new source context", async () => {
  const { session } = await fixture();
  session.request("agents", { cwd: "/one" });
  expect(session.request("worktrees", { cwd: "/two" }).context.cwd).toBe("/two");
  expect(() => session.request("all", { cwd: "x".repeat(MAX_TEST_CONTEXT) })).toThrow();
});

test("concurrent startup actions deliver the newest mode to one reserved child", async () => {
  const { session, env, root } = await fixture();
  let launch!: () => void;
  let began!: () => void;
  const launching = new Promise<void>(resolve => { began = resolve; });
  let opens = 0;
  const herdr = new Herdr({ runner: async argv => {
    opens++;
    const owner = argv.find(value => value.startsWith("HERDR_PICKERS_SESSION_TOKEN="))!.split("=")[1]!;
    await new Promise<void>(resolve => { launch = resolve; began(); });
    session.claim(owner);
    session.acknowledge(session.latestRequest()!.token, owner);
    return { stdout: OPEN_RESULT, stderr: "", exitCode: 0 };
  } });
  const actionEnv = { ...env, HERDR_PLUGIN_CONFIG_DIR: root, HERDR_PLUGIN_ID: PLUGIN_ID };
  const first = openPicker("agents", actionEnv, herdr);
  await launching;
  const second = openPicker("all", actionEnv, herdr);
  const last = openPicker("worktrees", actionEnv, herdr);
  launch();
  await Promise.all([first, second, last]);
  expect(opens).toBe(1);
  expect(session.latestRequest()?.mode).toBe("worktrees");
  expect(session.latestRequest()?.acknowledgedBy).toBeString();
});

test("a request during teardown waits for process death and pane removal", async () => {
  const { session, env, root } = await fixture();
  const old = await worker(env, "overlay");
  let panePresent = true;
  let probed!: () => void;
  const checked = new Promise<void>(resolve => { probed = resolve; });
  let opens = 0;
  const herdr = new Herdr({ runner: async argv => {
    if (argv.includes("list")) {
      probed();
      return { stdout: JSON.stringify({ result: { panes: panePresent ? [{ pane_id: PANE_ID }] : [] } }), stderr: "", exitCode: 0 };
    }
    opens++;
    const token = argv.find(value => value.startsWith("HERDR_PICKERS_SESSION_TOKEN="))!.split("=")[1]!;
    session.claim(token);
    session.acknowledge(session.latestRequest()!.token, token);
    return { stdout: OPEN_RESULT, stderr: "", exitCode: 0 };
  } });
  const run = openPicker("worktrees", { ...env, HERDR_PLUGIN_CONFIG_DIR: root, HERDR_PLUGIN_ID: PLUGIN_ID }, herdr);
  expect(opens).toBe(0);
  old.proc.stdin.end();
  await old.proc.exited;
  await checked;
  expect(opens).toBe(0);
  panePresent = false;
  await run;
  expect(opens).toBe(1);
  expect(session.latestRequest()?.mode).toBe("worktrees");
});

test("delivery waits for a delayed child claim after its opener exits", async () => {
  const { env, root, session } = await fixture();
  const old = await worker(env, "unclaimed");
  old.proc.stdin.end();
  await old.proc.exited;
  let opens = 0;
  const herdr = new Herdr({ runner: async () => { opens++; return { stdout: OPEN_RESULT, stderr: "", exitCode: 0 }; } });
  const run = openPicker("worktrees", { ...env, HERDR_PLUGIN_CONFIG_DIR: root, HERDR_PLUGIN_ID: PLUGIN_ID }, herdr);
  const outcome = run.then(() => "delivered", error => String(error));
  await Bun.sleep(LATE_CLAIM_MS);
  expect(session.claim(old.token!)).toBe(true);
  expect(session.acknowledge(session.latestRequest()!.token, old.token!)).toBe(true);
  expect(await outcome).toBe("delivered");
  expect(opens).toBe(0);
});

test("delivery deadline also bounds a stalled Herdr open command", async () => {
  const { env, root } = await fixture();
  let finish!: () => void;
  const herdr = new Herdr({ runner: async () => {
    await new Promise<void>(resolve => { finish = resolve; });
    return { stdout: OPEN_RESULT, stderr: "", exitCode: 0 };
  } });
  const run = openPicker("agents", { ...env, HERDR_PLUGIN_CONFIG_DIR: root, HERDR_PLUGIN_ID: PLUGIN_ID }, herdr);
  const observed = run.then(() => "delivered", error => String(error));
  const outcome = await Promise.race([observed, Bun.sleep(DEADLINE_PROBE_MS).then(() => DEADLINE_NOT_ENFORCED)]);
  finish();
  await observed;
  expect(outcome).not.toBe(DEADLINE_NOT_ENFORCED);
  expect(outcome).toContain("deadline");
});

test("forwards the exact reserved generation to the pane", () => {
  expect(buildPaneOpenArgs({ pluginId: PLUGIN_ID, mode: "all", token: STALE_TOKEN })).toContain(`HERDR_PICKERS_SESSION_TOKEN=${STALE_TOKEN}`);
});

test("reserves once across modes and placements before a child starts", async () => {
  const { session, env } = await fixture();
  const other = new PickerSession(env);
  sessions.push(other);
  const token = await session.reserve("overlay", async () => false);
  expect(typeof token).toBe("string");
  expect(await other.reserve("popup", async () => false)).toBeUndefined();
  expect(session.claim(token!, PANE_ID)).toBe(true);
  expect(session.claim(token!, PANE_ID)).toBe(false);
  expect(await other.reserve("overlay", async () => false)).toBeUndefined();
});

test("unsubmitted release cannot remove a different token or a claimed child", async () => {
  const { session } = await fixture();
  const token = await session.reserve("popup", async () => false);
  session.releaseUnsubmitted(STALE_TOKEN);
  expect(await session.reserve("popup", async () => false)).toBeUndefined();
  expect(session.claim(token!)).toBe(true);
  session.releaseUnsubmitted(token!);
  expect(await session.reserve("popup", async () => false)).toBeUndefined();
});

test("ambiguous command errors preserve the reservation for a delayed child", async () => {
  const { session, env, root } = await fixture();
  let token!: string;
  const herdr = new Herdr({ runner: async argv => {
    token = argv.find(value => value.startsWith("HERDR_PICKERS_SESSION_TOKEN="))!.split("=")[1]!;
    throw new Error("transport lost after submission");
  } });
  await expect(openPicker("agents", { ...env, HERDR_PLUGIN_CONFIG_DIR: root, HERDR_PLUGIN_ID: PLUGIN_ID }, herdr)).rejects.toThrow();
  expect(await session.reserve("popup", async () => false)).toBeUndefined();
  expect(session.claim(token)).toBe(true);
});

test("rejects stale children without changing a current reservation", async () => {
  const { session } = await fixture();
  const token = await session.reserve("popup", async () => false);
  expect(session.claim(STALE_TOKEN)).toBe(false);
  expect(session.claim(token!)).toBe(true);
  expect(await session.reserve("overlay", async () => false)).toBeUndefined();
});

test("keeps sessions independent with shared plugin storage", async () => {
  const { root, session } = await fixture();
  const socketPath = join(root, SECOND_SOCKET_NAME);
  const server = createServer();
  servers.push(server);
  await new Promise<void>(resolve => server.listen(socketPath, resolve));
  const other = new PickerSession({ HERDR_PLUGIN_STATE_DIR: root, HERDR_SOCKET_PATH: socketPath });
  sessions.push(other);
  expect(await session.reserve("popup", async () => false)).toBeString();
  expect(await other.reserve("overlay", async () => false)).toBeString();
  const first = session.request("agents", {});
  const second = other.request("worktrees", {});
  expect(session.latestRequest()?.token).toBe(first.token);
  expect(other.latestRequest()?.token).toBe(second.token);
  expect(session.acknowledge(second.token, STALE_TOKEN)).toBe(false);
});

test("directory aliases cannot bypass session identity", async () => {
  const { root, env, session } = await fixture();
  const alias = join(root, ALIAS_NAME);
  symlinkSync(root, alias);
  const other = new PickerSession({ ...env, HERDR_SOCKET_PATH: join(alias, SOCKET_NAME) });
  sessions.push(other);
  expect(await session.reserve("popup", async () => false)).toBeString();
  expect(await other.reserve("overlay", async () => false)).toBeUndefined();
});

test("a replacement socket has independent ownership", async () => {
  const { env, session } = await fixture();
  expect(await session.reserve("popup", async () => false)).toBeString();
  const original = servers.pop()!;
  await new Promise<void>(resolve => original.close(() => resolve()));
  const replacement = createServer();
  servers.push(replacement);
  await new Promise<void>(resolve => replacement.listen(env.HERDR_SOCKET_PATH, resolve));
  const other = new PickerSession(env);
  sessions.push(other);
  expect(await other.reserve("overlay", async () => false)).toBeString();
});

test("does not follow an ownership database symlink", async () => {
  const { root, env, session } = await fixture();
  session.close();
  sessions.splice(sessions.indexOf(session), 1);
  const target = join(root, SENTINEL_NAME);
  writeFileSync(target, SENTINEL_CONTENT);
  rmSync(join(root, DATABASE_NAME));
  symlinkSync(target, join(root, DATABASE_NAME));
  expect(() => new PickerSession(env)).toThrow();
  expect(readFileSync(target, "utf8")).toBe(SENTINEL_CONTENT);
});

test("malformed pane lists never prove absence", () => {
  for (const envelope of [null, {}, { result: {} }, { result: { panes: null } }, { result: { panes: [{}] } }, { result: { panes: [{ pane_id: "" }] } }]) {
    expect(() => readPickerPaneIds(envelope)).toThrow();
  }
  expect(readPickerPaneIds({ result: { panes: [] } })).toEqual([]);
  expect(readPickerPaneIds({ result: { panes: [{ pane_id: PANE_ID, label: "not ownership" }] } })).toEqual([PANE_ID]);
});

test("refuses missing session identity rather than a global fallback", () => {
  expect(() => new PickerSession({})).toThrow();
});

async function worker(env: Record<string, string>, mode = "popup") {
  const proc = Bun.spawn([process.execPath, WORKER_PATH, mode], { env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  workers.push(proc);
  const reader = proc.stdout.getReader();
  const chunk = await reader.read();
  reader.releaseLock();
  if (!chunk.value) throw new Error(await new Response(proc.stderr).text());
  const result = JSON.parse(new TextDecoder().decode(chunk.value)) as { token: string | null; pid: number };
  return { proc, ...result };
}

test("multiple request processes share one latest-generation mailbox", async () => {
  const { session, env } = await fixture();
  const requests = await Promise.all(Array.from({ length: WORKER_COUNT }, () => worker(env, REQUEST_MODE)));
  expect(requests.every(request => typeof request.token === "string")).toBe(true);
  expect(new Set(requests.map(request => request.token)).size).toBe(WORKER_COUNT);
  expect(requests.map(request => request.token)).toContain(session.latestRequest()?.token ?? null);
  const last = session.request("worktrees", {});
  for (const request of requests) { request.proc.stdin.end(); await request.proc.exited; }
  expect(session.latestRequest()?.token).toBe(last.token);
});

test("concurrent processes converge on one owner and recover after exit", async () => {
  const { env, session } = await fixture();
  const contenders = await Promise.all(Array.from({ length: WORKER_COUNT }, () => worker(env)));
  const winners = contenders.filter(candidate => candidate.token !== null);
  expect(winners).toHaveLength(1);
  for (const candidate of contenders) { candidate.proc.stdin.end(); await candidate.proc.exited; }
  const next = await session.reserve("overlay", async () => false);
  expect(next).toBeString();
  expect(session.claim(winners[0]!.token!, PANE_ID)).toBe(false);
  expect(session.claim(next!, PANE_ID)).toBe(true);
});

test("waits for overlay removal even after its owner process exits", async () => {
  const { env, session } = await fixture();
  const owner = await worker(env, "overlay");
  owner.proc.stdin.end();
  await owner.proc.exited;
  expect(await session.reserve("popup", async pane => { expect(pane).toBe(PANE_ID); return true; })).toBeUndefined();
  expect(await session.reserve("popup", async () => false)).toBeString();
});

test("uncertain startup never permits a second request", async () => {
  const { env, session } = await fixture();
  const owner = await worker(env, "unclaimed");
  owner.proc.stdin.end();
  await owner.proc.exited;
  await expect(session.reserve("popup", async () => false)).rejects.toThrow("could not be verified");
});

test("a delayed reaper cannot remove a newer generation", async () => {
  const { env, session } = await fixture();
  const owner = await worker(env, "overlay");
  owner.proc.stdin.end();
  await owner.proc.exited;
  let finishProbe!: (exists: boolean) => void;
  const first = session.reserve("overlay", () => new Promise(resolve => { finishProbe = resolve; }));
  const newer = await session.reserve("popup", async () => false);
  expect(session.claim(newer!)).toBe(true);
  finishProbe(false);
  expect(await first).toBeUndefined();
  expect(await session.reserve("overlay", async () => false)).toBeUndefined();
});
