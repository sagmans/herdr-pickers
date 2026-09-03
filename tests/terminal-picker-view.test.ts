import { describe, expect, test } from "bun:test";

import type { PickerGroup, PickerItem } from "../src/picker-row.ts";
import {
  mouseAction,
  renderFrame,
  type PickerState,
  type Viewport,
} from "../src/terminal-picker-view.ts";

const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const ANSI_RESET = "\x1b[0m";
const TOKYO_GROUP = "\x1b[38;2;217;139;182m";
const TOKYO_SELECTED = "\x1b[38;2;139;217;174m";
const TOKYO_MUTED = "\x1b[38;2;115;122;162m";
const TOKYO_BLOCKED = "\x1b[38;2;247;118;142m";
const TOKYO_BLOCKED_RGB = { red: 247, green: 118, blue: 142 } as const;
const VIEWPORT: Viewport = { columns: 24, rows: 6 };
const TALL_VIEWPORT: Viewport = { columns: 24, rows: 8 };
const AGENT_NOUN = "agents";
const NO_AGENTS_MESSAGE = "No agents found.";
const SAMPLE_REPO_GROUP: PickerGroup = { key: "sample-repo", label: "sample-repo", display: "▾ sample-repo" };
const HERDR_GROUP: PickerGroup = { key: "herdr", label: "herdr", display: "▾ herdr" };
const ITEMS: readonly PickerItem[] = [
  { id: "pi", searchText: "sample-repo main pi", display: "  ✓ main ▸ pi", target: "pane-1", group: SAMPLE_REPO_GROUP },
  { id: "codex", searchText: "herdr feat codex", display: "  ● feat ▸ codex", target: "pane-2", group: HERDR_GROUP },
];
const STATE: PickerState = {
  prompt: "agents › ",
  noun: AGENT_NOUN,
  live: true,
  emptyMessage: NO_AGENTS_MESSAGE,
  query: "pi",
  items: ITEMS,
  sourceCount: ITEMS.length,
  selected: 0,
  scrollTop: 0,
};

function plain(value: string): string {
  return value.replaceAll(ANSI_PATTERN, "");
}

describe("terminal picker rendering", () => {
  test("balances count and close controls above matching content rails", () => {
    const frame = renderFrame(STATE, VIEWPORT);

    expect(frame).toHaveLength(VIEWPORT.rows);
    expect(plain(frame[0] ?? "")).toBe("2 agents · live✕");
    expect(frame[0]).toContain("\x1b[23G");
    expect(frame[0]).not.toContain("\x1b[7m");
    expect(plain(frame[1] ?? "")).toBe("─".repeat(VIEWPORT.columns));
    expect(plain(frame.at(-2) ?? "")).toBe("─".repeat(VIEWPORT.columns));
    expect(plain(frame.at(-1) ?? "")).toBe("agents › pi2 matches");
  });

  test("uses one Tokyo Night chrome palette", () => {
    const frame = renderFrame(STATE, VIEWPORT);
    const selected = frame.find((line) => plain(line).includes("main ▸ pi")) ?? "";

    expect(frame[0]).toStartWith(TOKYO_MUTED);
    expect(frame[1]).toStartWith(TOKYO_MUTED);
    expect(selected).toStartWith(`${TOKYO_SELECTED}→${ANSI_RESET}`);
    expect(frame.at(-1)).toStartWith(`${TOKYO_GROUP}agents › ${ANSI_RESET}`);
    expect(frame.at(-1)).toContain(`${TOKYO_MUTED}2 matches${ANSI_RESET}`);
  });

  test("uses an item-specific selection color when supplied", () => {
    const state = {
      ...STATE,
      items: [{ ...ITEMS[0]!, group: undefined, selectionColor: TOKYO_BLOCKED_RGB }],
    };
    const selected = renderFrame(state, VIEWPORT).find((line) => plain(line).includes("main ▸ pi")) ?? "";

    expect(selected).toStartWith(`${TOKYO_BLOCKED}→${ANSI_RESET}`);
  });

  test("keeps hidden targets out of rendered rows", () => {
    const frame = renderFrame(STATE, VIEWPORT).map(plain).join("\n");

    expect(frame).toContain("main ▸ pi");
    expect(frame).not.toContain("pane-1");
  });

  test("uses the supplied noun without a live suffix for static modes", () => {
    const state = { ...STATE, noun: "workspaces", live: false };

    expect(plain(renderFrame(state, VIEWPORT)[0] ?? "")).toBe("2 workspaces✕");
  });

  test("singularizes the supplied noun when the source count is one", () => {
    const state = { ...STATE, noun: "workspaces", live: false, sourceCount: 1 };

    expect(plain(renderFrame(state, VIEWPORT)[0] ?? "")).toBe("1 workspace✕");
  });

  test("renders configured empty copy inside the result area", () => {
    const state = { ...STATE, query: "", items: [], sourceCount: 0, selected: -1 };
    const frame = renderFrame(state, VIEWPORT).map(plain);

    expect(frame[3]).toBe(NO_AGENTS_MESSAGE);
    expect(frame.at(-1)).toBe("agents › 0 matches");
  });

  test("bottom-aligns short lists directly above the prompt", () => {
    const state = { ...STATE, items: STATE.items.slice(0, 1), selected: 0 };
    const frame = renderFrame(state, TALL_VIEWPORT).map(plain);

    expect(frame.slice(2, 6)).toEqual([
      "",
      "",
      "  ▾ sample-repo",
      "→   ✓ main ▸ pi",
    ]);
    expect(frame[6]).toBe("─".repeat(TALL_VIEWPORT.columns));
    expect(frame[7]).toBe("agents › pi1 match");
  });

  test("hides the match count before it can overlap wide query text", () => {
    const state = { ...STATE, query: "界界界界" };

    expect(plain(renderFrame(state, VIEWPORT).at(-1) ?? "")).toBe("agents › 界界界界");
  });

  test("uses the bright display only for the selected item", () => {
    const state = {
      ...STATE,
      items: [
        { ...ITEMS[0]!, group: undefined, display: "normal pi", selectedDisplay: "bright pi" },
        { ...ITEMS[1]!, group: undefined, display: "normal codex", selectedDisplay: "bright codex" },
      ],
    };
    const frame = renderFrame(state, TALL_VIEWPORT).map(plain).join("\n");

    expect(frame).toContain("→ bright pi");
    expect(frame).toContain("  normal codex");
    expect(frame).not.toContain("bright codex");
  });
});

describe("terminal picker mouse mapping", () => {
  test("closes only from the small top-right button hit area", () => {
    expect(mouseAction({ type: "mouse", button: "left", column: 23, row: 1, released: false }, STATE, VIEWPORT)).toEqual({ type: "close" });
    expect(mouseAction({ type: "mouse", button: "left", column: 2, row: 1, released: false }, STATE, VIEWPORT)).toEqual({ type: "none" });
  });

  test("maps list clicks through the scroll offset", () => {
    const state = { ...STATE, scrollTop: 2 };

    expect(mouseAction({ type: "mouse", button: "left", column: 5, row: 4, released: false }, state, VIEWPORT)).toEqual({ type: "select", index: 1 });
  });

  test("maps clicks from the bottom-aligned start of a short list", () => {
    const state = { ...STATE, items: STATE.items.slice(0, 1), selected: 0 };

    expect(mouseAction({ type: "mouse", button: "left", column: 5, row: 4, released: false }, state, TALL_VIEWPORT)).toEqual({ type: "none" });
    expect(mouseAction({ type: "mouse", button: "left", column: 5, row: 5, released: false }, state, TALL_VIEWPORT)).toEqual({ type: "none" });
    expect(mouseAction({ type: "mouse", button: "left", column: 5, row: 6, released: false }, state, TALL_VIEWPORT)).toEqual({ type: "select", index: 0 });
  });
});
