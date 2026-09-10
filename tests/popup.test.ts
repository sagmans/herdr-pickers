import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

import { closePickerSurface } from "../src/client/popup.ts";

const SOCKET_PATH = "/tmp/herdr.sock";
const PANE_ID = "w1:p1";
const CLOSE_DEADLINE_MS = 500;
const REPLY_PREFIX = '{"id":"herdr-pickers:overlay-close","result":{"type":"ok"}}';
const REPLY_END = "\n";
const SOCKET_FIXTURE_PREFIX = "/tmp/hpc-";
const REPLY_PAUSE_MS = 10;

describe("picker dismissal", () => {
  test("leaves unidentified popups to native process-exit cleanup", async () => {
    const writes: string[] = [];
    await closePickerSurface({ HERDR_SOCKET_PATH: SOCKET_PATH }, async (_path, payload) => { writes.push(payload); });
    expect(writes).toEqual([]);
  });

  test("rejects missing Herdr socket context for an owned overlay", async () => {
    await expect(closePickerSurface({ HERDR_PANE_ID: PANE_ID })).rejects.toThrow("HERDR_SOCKET_PATH");
  });

  test("closes an overlay picker pane by id without popup.close", async () => {
    const writes: Array<{ path: string; payload: string }> = [];
    await closePickerSurface({ HERDR_SOCKET_PATH: SOCKET_PATH, HERDR_PANE_ID: PANE_ID }, async (path, payload) => {
      writes.push({ path, payload });
    });
    expect(writes).toHaveLength(1);
    expect(writes[0]?.path).toBe(SOCKET_PATH);
    expect(JSON.parse(writes[0]?.payload.trim() ?? "{}")).toEqual({
      id: "herdr-pickers:overlay-close", method: "plugin.pane.close", params: { pane_id: PANE_ID },
    });
  });

  test("waits for the server reply before allowing terminal cleanup", async () => {
    const root = mkdtempSync(SOCKET_FIXTURE_PREFIX);
    const path = join(root, "api.sock");
    const server = createServer({ allowHalfOpen: true });
    let received!: () => void;
    const requestReceived = new Promise<void>(resolve => { received = resolve; });
    let reply!: () => void;
    let disconnect = () => {};
    server.on("connection", socket => {
      disconnect = () => socket.destroy();
      socket.on("error", () => {});
      socket.once("data", () => {
        reply = () => socket.end(REPLY_END);
        socket.write(REPLY_PREFIX);
        received();
      });
    });
    try {
      await new Promise<void>(resolve => server.listen(path, resolve));
      let completed = false;
      const close = closePickerSurface({ HERDR_SOCKET_PATH: path, HERDR_PANE_ID: PANE_ID })
        .then(() => { completed = true; });
      await requestReceived;
      await Bun.sleep(REPLY_PAUSE_MS);
      expect(completed).toBe(false);
      reply();
      await close;
      expect(completed).toBe(true);
    } finally {
      disconnect();
      server.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not wait forever when overlay close socket stalls", async () => {
    const started = Date.now();
    await closePickerSurface({ HERDR_SOCKET_PATH: SOCKET_PATH, HERDR_PANE_ID: PANE_ID }, () => new Promise(() => {}));
    expect(Date.now() - started).toBeLessThan(CLOSE_DEADLINE_MS);
  });
});
