import { describe, expect, test } from "bun:test";

import { closePopup } from "../src/client/popup.ts";

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
});
