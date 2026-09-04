import { describe, expect, test } from "bun:test";

import { closePickerSurface } from "../src/client/popup.ts";

const SOCKET_PATH = "/tmp/herdr.sock";
const PANE_ID = "w1:p1";
const CLOSE_DEADLINE_MS = 500;

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

  test("does not wait forever when overlay close socket stalls", async () => {
    const started = Date.now();
    await closePickerSurface({ HERDR_SOCKET_PATH: SOCKET_PATH, HERDR_PANE_ID: PANE_ID }, () => new Promise(() => {}));
    expect(Date.now() - started).toBeLessThan(CLOSE_DEADLINE_MS);
  });
});
