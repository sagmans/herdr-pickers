import { describe, expect, test } from "bun:test";

import { FZF_MIN_VERSION, rankRows } from "../src/fzf.ts";
import type { PickerItem } from "../src/picker-row.ts";

function item(searchText: string, target: string, display = searchText): PickerItem {
  return { id: target, searchText, display, target };
}

describe("fzf ranking", () => {
  test("preserves source order without a query", async () => {
    const lines = [item("beta", "pane-b"), item("alpha", "pane-a")];

    expect(await rankRows("", lines)).toEqual(lines);
  });

  test("returns full rows ranked by visible fields", async () => {
    const lines = [item("beta", "pane-b"), item("alphabet", "pane-a2"), item("alpha", "pane-a1")];

    expect(await rankRows("alpha", lines)).toEqual([
      lines[2]!,
      lines[1]!,
    ]);
  });

  test("preserves exact ANSI styling from source rows", async () => {
    const lines = [
      item("alphabet", "pane-a2", "\x1b[33malphabet\x1b[0m"),
      item("alpha", "pane-a1", "\x1b[36malpha\x1b[0m"),
    ];

    expect(await rankRows("alpha", lines)).toEqual([
      lines[1]!,
      lines[0]!,
    ]);
  });

  test("does not search hidden agent targets", async () => {
    expect(await rankRows("pane-b", [item("beta", "pane-b")])).toEqual([]);
  });
});

describe("fzf floor", () => {
  test("requires the mouse-era fzf", () => {
    expect(FZF_MIN_VERSION).toBe("0.48");
  });
});
