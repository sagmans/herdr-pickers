import { describe, expect, test } from "bun:test";

import { closePickerSurface, POPUP_SURFACE } from "../src/client/popup.ts";
import { withPickerSurface } from "../src/picker-surface.ts";
import { formatErrorBlock } from "../src/util/errors.ts";
import { FakeTerminal } from "./terminal-picker-test-support.ts";

const STOP_SCREEN = "\x1b[?1049l";
const COMBINED_FAILURE = "Picker failed and its surface could not be closed.";
const FRAME = "frame";

/** Touches the terminal so restoration is observable; an idle terminal writes nothing. */
function draw(terminal: { lease(signal?: AbortSignal): { write(value: string): void } }): void {
  terminal.lease().write(FRAME);
}

describe("picker surface lifecycle", () => {
  test("closes after successful picker work", async () => {
    const terminal = new FakeTerminal([]);
    let closes = 0;

    const result = await withPickerSurface(POPUP_SURFACE, undefined, terminal, async surface => {
      draw(surface);
      return "selected";
    }, async () => {
      closes += 1;
    });

    expect(result).toBe("selected");
    expect(closes).toBe(1);
  });

  test("closes after picker failure without hiding the original error", async () => {
    const pickerError = new Error("picker failed");
    const terminal = new FakeTerminal([]);

    await expect(withPickerSurface(POPUP_SURFACE, undefined, terminal, async () => { throw pickerError; }, async () => {})).rejects.toBe(pickerError);
  });

  test("aggregates picker and close failures", async () => {
    const pickerError = new Error("picker failed");
    const closeError = new Error("close failed");
    const terminal = new FakeTerminal([]);

    try {
      await withPickerSurface(POPUP_SURFACE, undefined, terminal, async () => { throw pickerError; }, async () => { throw closeError; });
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors).toEqual([pickerError, closeError]);
      expect(formatErrorBlock(error)).toBe(`${COMBINED_FAILURE}\npicker failed\nclose failed`);
    }
  });

  test("does not retry a failed close after successful picker work", async () => {
    const terminal = new FakeTerminal([]);
    let closes = 0;

    await expect(withPickerSurface(POPUP_SURFACE, undefined, terminal, async () => "selected", async () => {
      closes += 1;
      throw new Error("close failed");
    })).rejects.toThrow("close failed");

    expect(closes).toBe(1);
  });

  test("restores the terminal after picker and close failures", async () => {
    const terminal = new FakeTerminal([]);

    await expect(withPickerSurface(POPUP_SURFACE, undefined, terminal, async surface => {
      draw(surface);
      throw new Error("picker failed");
    }, async () => { throw new Error("close failed"); })).rejects.toThrow(COMBINED_FAILURE);

    expect(terminal.rawModes).toEqual([true, false]);
    expect(terminal.writes.filter(write => write.includes(STOP_SCREEN))).toHaveLength(1);
    expect(terminal.inputReturned).toBe(true);
  });

  test("dismisses before restoring the terminal", async () => {
    const terminal = new FakeTerminal([]);

    await withPickerSurface(POPUP_SURFACE, undefined, terminal, async surface => {
      draw(surface);
    }, async () => {
      expect(terminal.writes.join("")).not.toContain(STOP_SCREEN);
    });

    expect(terminal.writes.at(-1)).toContain(STOP_SCREEN);
  });

  test("aggregate failure messages stay bounded and control-free", () => {
    const noisy = new Error("\u001B]0;pwned\u0007" + "x".repeat(5000));
    const error = new AggregateError([noisy, new Error("close \u2066failed")], "combined \u202Efailure");

    const formatted = formatErrorBlock(error);

    expect(formatted.length).toBeLessThanOrEqual(2048);
    expect(formatted).not.toContain("\u001B");
    expect(formatted).not.toContain("\u2066");
    expect(formatted).not.toContain("\u202E");
    expect(formatted).toContain("\n");
  });
});

describe("popup surface close", () => {
  test("closing a popup never writes to the socket", async () => {
    const writes: string[] = [];

    await closePickerSurface(POPUP_SURFACE, "/tmp/herdr.sock", async (_path, payload) => { writes.push(payload); });

    expect(writes).toEqual([]);
  });
});
