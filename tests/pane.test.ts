import { describe, expect, test } from "bun:test";

import { formatPaneError, withPopupClose } from "../src/pane.ts";

describe("popup pane lifecycle", () => {
  test("closes after successful picker work", async () => {
    let closes = 0;

    const result = await withPopupClose(async () => "selected", async () => {
      closes += 1;
    });

    expect(result).toBe("selected");
    expect(closes).toBe(1);
  });

  test("closes after picker failure without hiding the original error", async () => {
    const pickerError = new Error("picker failed");

    await expect(withPopupClose(async () => { throw pickerError; }, async () => {})).rejects.toBe(pickerError);
  });

  test("aggregates picker and close failures", async () => {
    const pickerError = new Error("picker failed");
    const closeError = new Error("close failed");

    try {
      await withPopupClose(async () => { throw pickerError; }, async () => { throw closeError; });
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors).toEqual([pickerError, closeError]);
    }
  });

  test("does not retry a failed close after successful picker work", async () => {
    let closes = 0;

    await expect(withPopupClose(async () => "selected", async () => {
      closes += 1;
      throw new Error("close failed");
    })).rejects.toThrow("close failed");

    expect(closes).toBe(1);
  });

  test("formats both causes of a combined failure", () => {
    const error = new AggregateError([new Error("picker failed"), new Error("close failed")], "combined failure");

    expect(formatPaneError(error)).toBe("combined failure\npicker failed\nclose failed");
  });

  test("aggregate failure messages stay bounded and control-free", () => {
    const noisy = new Error("\u001B]0;pwned\u0007" + "x".repeat(5000));
    const error = new AggregateError([noisy, new Error("close \u2066failed")], "combined \u202Efailure");

    const formatted = formatPaneError(error);

    expect(formatted.length).toBeLessThanOrEqual(2048);
    expect(formatted).not.toContain("\u001B");
    expect(formatted).not.toContain("\u2066");
    expect(formatted).not.toContain("\u202E");
    expect(formatted).toContain("\n");
  });
});

