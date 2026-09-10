import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { PickerSession, PICKER_TOKEN_ENV } from "../src/picker-session.ts";

const TEMP_PREFIX = "/tmp/hpp-focus-";
const PANE = "picker-pane";
const OTHER = "other-pane";
const TAB = "picker-tab";
const WORKSPACE = "picker-workspace";
const STOP = "\x1b[?1049l";
const PRIVATE_EXECUTABLE_MODE = 0o700;
const TEST_TIMEOUT_MS = 10_000;
const PTY = join(import.meta.dir, "fixtures/picker-pane-pty.py");
const ENTRYPOINT = join(import.meta.dir, "../src/pane.ts");
const FAKE_COMMAND = `#!${process.execPath}
import { createConnection } from "node:net";
const socket = createConnection(process.env.HERDR_SOCKET_PATH);
socket.on("connect", () => socket.write(JSON.stringify({ method: "test.command", args: process.argv.slice(2) }) + "\\n"));
socket.on("data", data => process.stdout.write(data));
`;

function snapshot(focused: boolean) {
  return { result: { type: "session_snapshot", snapshot: {
    focused_workspace_id: WORKSPACE, focused_tab_id: TAB, focused_pane_id: focused ? PANE : OTHER,
    workspaces: [{ workspace_id: WORKSPACE, focused: true, active_tab_id: TAB }],
    tabs: [{ tab_id: TAB, workspace_id: WORKSPACE, focused: true }],
    panes: [{ pane_id: PANE, tab_id: TAB, workspace_id: WORKSPACE, focused }],
  } } };
}

for (const scenario of ["setup-error", "protocol-error", "departure"] as const) {
  test(`pane entrypoint distinguishes ${scenario} from cancellation`, async () => {
    const root = mkdtempSync(TEMP_PREFIX);
    const socketPath = join(root, "s");
    const binary = join(root, "herdr-test.ts");
    writeFileSync(binary, FAKE_COMMAND, { mode: PRIVATE_EXECUTABLE_MODE });
    const sockets = new Set<Socket>();
    let observer: Socket | undefined;
    let snapshots = 0;
    let closes = 0;
    const server = createServer(socket => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      let buffer = "";
      socket.on("data", data => {
        buffer += data.toString();
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const request = JSON.parse(buffer.slice(0, newline));
        buffer = "";
        if (request.method === "events.subscribe") {
          observer = socket;
          const result = scenario === "setup-error" ? { error: { message: "private detail" } } : { result: { type: "subscription_started" } };
          socket.write(JSON.stringify({ id: request.id, ...result }) + "\n");
        } else if (request.method === "plugin.pane.close") {
          closes++;
          socket.end("{}\n");
        } else if (request.method === "test.command") {
          if (request.args.includes("snapshot")) {
            snapshots++;
            socket.end(JSON.stringify(snapshot(snapshots === 1)));
            if (snapshots === 1) socket.once("close", () => {
              observer?.write(scenario === "protocol-error" ? "{malformed private detail}\n" : JSON.stringify({
                event: "pane_focused", data: { type: "pane_focused", pane_id: OTHER, workspace_id: WORKSPACE },
              }) + "\n");
            });
          } else socket.end(JSON.stringify({ result: { workspaces: [] } }));
        }
      });
    });
    await new Promise<void>(resolve => server.listen(socketPath, resolve));
    const env = { HERDR_SOCKET_PATH: socketPath, HERDR_PLUGIN_STATE_DIR: root, HERDR_PLUGIN_CONFIG_DIR: root,
      HERDR_PANE_ID: PANE, HERDR_BIN_PATH: binary };
    const session = new PickerSession(env);
    let process: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
    try {
      const probe = Bun.spawn([binary, "workspace", "list"], { env, stdout: "pipe", stderr: "pipe" });
      expect(await new Response(probe.stderr).text()).toBe("");
      expect(await probe.exited).toBe(0);
      const token = await session.reserve("overlay", async () => false);
      session.request("workspaces", {});
      process = Bun.spawn(["python3", PTY, Bun.which("bun")!, ENTRYPOINT], {
        env: { ...env, [PICKER_TOKEN_ENV]: token! }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      });
      const [output, error, status] = await Promise.all([
        new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited,
      ]);
      expect(error).toBe("");
      expect(status).toBe(scenario === "departure" ? 0 : 1);
      expect(output).toContain(STOP);
      expect(closes).toBe(1);
      expect(output).not.toContain("private detail");
      if (scenario !== "departure") expect(output).toMatch(/picker focus observation/i);
      else expect(snapshots).toBeGreaterThan(1);
    } finally {
      if (process?.exitCode === null) { process.kill(); await process.exited; }
      session.close();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  }, TEST_TIMEOUT_MS);
}
