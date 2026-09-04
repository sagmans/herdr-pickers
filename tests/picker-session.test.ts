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

test("shared action entrypoint ignores another mode while reserved", async () => {
  const { env, root } = await fixture();
  const commands: string[][] = [];
  const herdr = new Herdr({ runner: async argv => {
    commands.push([...argv]);
    return { stdout: OPEN_RESULT, stderr: "", exitCode: 0 };
  } });
  const actionEnv = { ...env, HERDR_PLUGIN_CONFIG_DIR: root, HERDR_PLUGIN_ID: PLUGIN_ID };
  await openPicker("workspaces", actionEnv, herdr);
  await openPicker("agents", actionEnv, herdr);
  expect(commands).toHaveLength(1);
  expect(commands[0]?.some(value => value.startsWith("HERDR_PICKERS_SESSION_TOKEN="))).toBe(true);
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
