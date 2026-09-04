import { describe, expect, test } from "bun:test";

import { closePickerSurface, closePopup } from "../src/client/popup.ts";

describe("popup dismissal", () => {
  test("sends popup.close through the Herdr socket", async () => {
    const writes: Array<{ path: string; payload: string }> = [];

    await closePopup({ HERDR_SOCKET_PATH: "/tmp/herdr.sock" }, async (path, payload) => {
      writes.push({ path, payload });
    });

    expect(writes).toHaveLength(1);
    expect(writes[0]?.path).toBe("/tmp/herdr.sock");
    expect(writes[0]?.payload.endsWith("\n")).toBe(true);
    expect(JSON.parse(writes[0]?.payload.trim() ?? "{}")).toEqual({
      id: "herdr-pickers:popup-close",
      method: "popup.close",
      params: {},
    });
  });

  test("rejects missing Herdr socket context", async () => {
    await expect(closePopup({})).rejects.toThrow("HERDR_SOCKET_PATH");
  });

  test("closes popup when the picker has no pane id", async () => {
    const writes: Array<{ path: string; payload: string }> = [];

    await closePickerSurface({ HERDR_SOCKET_PATH: "/tmp/herdr.sock" }, async (path, payload) => {
      writes.push({ path, payload });
    });

    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0]?.payload.trim() ?? "{}")).toEqual({
      id: "herdr-pickers:popup-close",
      method: "popup.close",
      params: {},
    });
  });

  test("closes an overlay picker pane by id without popup.close", async () => {
    const writes: Array<{ path: string; payload: string }> = [];

    await closePickerSurface({
      HERDR_SOCKET_PATH: "/tmp/herdr.sock",
      HERDR_PANE_ID: "w1:p1",
    }, async (path, payload) => {
      writes.push({ path, payload });
    });

    expect(writes).toHaveLength(1);
    expect(writes[0]?.path).toBe("/tmp/herdr.sock");
    expect(JSON.parse(writes[0]?.payload.trim() ?? "{}")).toEqual({
      id: "herdr-pickers:overlay-close",
      method: "plugin.pane.close",
      params: { pane_id: "w1:p1" },
    });
  });

  test("does not wait forever when overlay close socket stalls", async () => {
    const started = Date.now();
    await closePickerSurface({
      HERDR_SOCKET_PATH: "/tmp/herdr.sock",
      HERDR_PANE_ID: "w1:p1",
    }, () => new Promise(() => {}));
    expect(Date.now() - started).toBeLessThan(500);
  });
});
