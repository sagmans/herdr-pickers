import { describe, expect, test } from "bun:test";

import {
  mouseAction,
  parseInput,
  renderFrame,
  runTerminalPicker,
  type PickerState,
  type TerminalAdapter,
  type Viewport,
} from "../src/terminal-picker.ts";
import type { PickerGroup, PickerItem } from "../src/picker-row.ts";

const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const ANSI_RESET = "\x1b[0m";
const TOKYO_GROUP = "\x1b[38;2;217;139;182m";
const TOKYO_SELECTED = "\x1b[38;2;139;217;174m";
const TOKYO_MUTED = "\x1b[38;2;115;122;162m";
const TOKYO_BLOCKED = "\x1b[38;2;247;118;142m";
const TOKYO_BLOCKED_RGB = { red: 247, green: 118, blue: 142 } as const;
const VIEWPORT: Viewport = { columns: 24, rows: 6 };
const TALL_VIEWPORT: Viewport = { columns: 24, rows: 8 };
const REFRESH_INTERVAL_MILLISECONDS = 1000;
const AGENT_NOUN = "agents";
const NO_AGENTS_MESSAGE = "No agents found.";
const AGENT_PICKER_OPTIONS = { noun: AGENT_NOUN, live: true, emptyMessage: NO_AGENTS_MESSAGE } as const;
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

describe("terminal input parsing", () => {
  test("parses SGR mouse presses and keyboard controls", () => {
    const parsed = parseInput("\x1b[<0;2;1M\x1b[A\x0e\rpi");

    expect(parsed.remainder).toBe("");
    expect(parsed.events).toEqual([
      { type: "mouse", button: "left", column: 2, row: 1, released: false },
      { type: "up" },
      { type: "down" },
      { type: "accept" },
      { type: "text", value: "p" },
      { type: "text", value: "i" },
    ]);
  });

  test("retains an incomplete SGR mouse sequence for the next chunk", () => {
    expect(parseInput("\x1b[<0;2")).toEqual({ events: [], remainder: "\x1b[<0;2" });
  });

  test("retains a lone escape byte and ignores C1 control sequences", () => {
    expect(parseInput("\x1b")).toEqual({ events: [], remainder: "\x1b" });
    expect(parseInput("\u009b31m")).toEqual({ events: [], remainder: "" });
  });
});

class FakeTerminal implements TerminalAdapter {
  readonly writes: string[] = [];
  readonly rawModes: boolean[] = [];
  readonly input: AsyncIterable<string | Uint8Array>;
  private resizeListener: (() => void) | undefined;
  private finishInput: (() => void) | undefined;

  constructor(
    chunks: readonly (string | Uint8Array | Promise<string | Uint8Array>)[],
    private viewport: Viewport = VIEWPORT,
    hangAfterInput = false,
    private failStopWrite = false,
  ) {
    let finishInput: (() => void) | undefined;
    this.input = (async function* () {
      for (const chunk of chunks) yield await chunk;
      if (hangAfterInput) await new Promise<void>((resolve) => {
        finishInput = resolve;
      });
    })();
    this.finishInput = () => finishInput?.();
  }

  write(value: string): void {
    this.writes.push(value);
    if (this.failStopWrite && value.includes("\x1b[?1049l")) throw new Error("stop write failed");
  }

  setRawMode(enabled: boolean): void {
    this.rawModes.push(enabled);
  }

  getViewport(): Viewport {
    return this.viewport;
  }

  onResize(listener: () => void): () => void {
    this.resizeListener = listener;
    return () => {
      this.resizeListener = undefined;
    };
  }

  finish(): void {
    this.finishInput?.();
  }
}

class FakeTimers {
  private readonly intervals: Array<{ readonly callback: () => void; readonly milliseconds: number; active: boolean }> = [];

  readonly setInterval = (callback: () => void, milliseconds: number): unknown => {
    const interval = { callback, milliseconds, active: true };
    this.intervals.push(interval);
    return interval;
  };

  readonly clearInterval = (handle: unknown): void => {
    const interval = handle as { active?: boolean };
    interval.active = false;
  };

  fire(milliseconds: number): void {
    for (const interval of this.intervals) {
      if (interval.active && interval.milliseconds === milliseconds) interval.callback();
    }
  }

  activeCount(): number {
    return this.intervals.filter((interval) => interval.active).length;
  }
}

describe("terminal picker session", () => {
  test("positions the visible cursor at the first search character", async () => {
    const terminal = new FakeTerminal([], VIEWPORT, true);
    const run = runTerminalPicker({ ...AGENT_PICKER_OPTIONS, prompt: "agents › ", items: STATE.items, terminal });

    expect(terminal.writes.at(-1)).toEndWith("\x1b[6;10H\x1b[?25h");

    terminal.finish();
    await run;
  });

  test("restores terminal state after clicking the close button", async () => {
    const terminal = new FakeTerminal(["\x1b[<0;23;1M"]);

    expect(await runTerminalPicker({ ...AGENT_PICKER_OPTIONS, prompt: "agents> ", items: STATE.items, terminal })).toBeUndefined();

    expect(terminal.rawModes).toEqual([true, false]);
    const output = terminal.writes.join("");
    expect(output).toContain("\x1b[?1049h");
    expect(output).toContain("\x1b[?1006h");
    expect(output).toContain("\x1b[?1006l");
    expect(output).toContain("\x1b[?1049l");
  });

  test("ranks typed queries and accepts the selected full row", async () => {
    const terminal = new FakeTerminal(["p", "\r"]);
    const queries: string[] = [];
    const ranker = async (query: string, items: readonly PickerItem[]): Promise<PickerItem[]> => {
      queries.push(query);
      return items.filter((item) => item.searchText.includes("pi"));
    };

    const result = await runTerminalPicker({ ...AGENT_PICKER_OPTIONS, prompt: "agents> ", items: STATE.items, terminal, ranker });

    expect(queries).toEqual(["p"]);
    expect(result?.target).toBe("pane-1");
  });

  test("points at the focused row before any input", async () => {
    const terminal = new FakeTerminal(["\x03"]);

    await runTerminalPicker({ ...AGENT_PICKER_OPTIONS, prompt: "agents> ", items: STATE.items, focusedId: "codex", terminal });

    const frame = plain(terminal.writes.filter((write) => write.includes("\x1b[2J"))[0] ?? "").split("\r\n");
    const focusedLine = frame.find((line) => line.includes("feat ▸ codex")) ?? "";
    const otherLine = frame.find((line) => line.includes("main ▸ pi")) ?? "";
    expect(focusedLine).toContain("→");
    expect(otherLine).not.toContain("→");
  });

  test("typing selects the best match and clearing returns to the focused row", async () => {
    const items: PickerItem[] = [
      { id: "zeta", searchText: "zeta", display: "zeta", target: "z" },
      { id: "alpha", searchText: "alpha", display: "alpha", target: "a" },
    ];
    const terminal = new FakeTerminal(["a", "\x1b", "\r"]);
    const ranker = async (query: string, ranked: readonly PickerItem[]): Promise<PickerItem[]> =>
      query.length === 0
        ? [...ranked]
        : ranked.filter((item) => item.searchText.includes(query)).toSorted((left, right) => left.id.localeCompare(right.id));

    const result = await runTerminalPicker({
      ...AGENT_PICKER_OPTIONS,
      prompt: "agents> ",
      items,
      focusedId: "zeta",
      terminal,
      ranker,
    });

    // "a" ranks alpha first, so typing must move the pointer off the focused
    // row; clearing the query hands it back to the focused row for Enter.
    expect(result?.target).toBe("z");
  });

  test("accepts a row on the second click", async () => {
    const click = "\x1b[<0;4;4M\x1b[<0;4;4m";
    const terminal = new FakeTerminal([click, click]);
    const times = [100, 250];

    const result = await runTerminalPicker({
      ...AGENT_PICKER_OPTIONS,
      prompt: "agents> ",
      items: STATE.items,
      terminal,
      now: () => times.shift() ?? 250,
    });

    expect(result?.target).toBe("pane-1");
  });

  test("preserves UTF-8 characters split across input chunks", async () => {
    const encoded = new TextEncoder().encode("π");
    const terminal = new FakeTerminal([encoded.slice(0, 1), encoded.slice(1), "\r"]);
    const queries: string[] = [];
    const ranker = async (query: string, items: readonly PickerItem[]): Promise<PickerItem[]> => {
      queries.push(query);
      return [...items];
    };

    await runTerminalPicker({ ...AGENT_PICKER_OPTIONS, prompt: "agents> ", items: STATE.items, terminal, ranker });

    expect(queries).toEqual(["π"]);
  });

  test("scrolls the visible rows with the mouse wheel", async () => {
    const wheelDown = "\x1b[<65;4;2M";
    const close = "\x1b[<0;23;1M";
    const terminal = new FakeTerminal([wheelDown, close], VIEWPORT);
    const items = Array.from({ length: 8 }, (_, index): PickerItem => ({
      id: `row-${index}`,
      searchText: `row-${index}`,
      display: `row-${index}`,
      target: `pane-${index}`,
    }));

    await runTerminalPicker({ ...AGENT_PICKER_OPTIONS, prompt: "agents> ", items, terminal });

    const redraw = plain(terminal.writes.at(-2) ?? "");
    expect(redraw).toContain("row-3");
    expect(redraw).not.toContain("row-0");
  });

  test("does not treat the same index after filtering as a double-click", async () => {
    const clickFirstRow = "\x1b[<0;4;3M\x1b[<0;4;3m";
    const clickFilteredRow = "\x1b[<0;4;4M\x1b[<0;4;4m";
    const items = ITEMS.map(({ group: _group, ...item }) => item);
    const terminal = new FakeTerminal([clickFirstRow, "z", clickFilteredRow, "\x03"]);
    const ranker = async (): Promise<PickerItem[]> => [items[1]!];
    const times = [100, 200];

    const result = await runTerminalPicker({
      ...AGENT_PICKER_OPTIONS,
      prompt: "agents> ",
      items,
      terminal,
      ranker,
      now: () => times.shift() ?? 200,
    });

    expect(result).toBeUndefined();
  });

  test("clears search on Escape and reloads rows on Ctrl-r", async () => {
    const terminal = new FakeTerminal(["p", "\x1b", "\x12", "\x03"]);
    const queries: string[] = [];
    let reloads = 0;

    await runTerminalPicker({
      ...AGENT_PICKER_OPTIONS,
      prompt: "agents> ",
      items: STATE.items,
      terminal,
      ranker: async (query, items) => {
        queries.push(query);
        return [...items];
      },
      reload: async () => {
        reloads += 1;
        return { items: STATE.items, focusedId: "pi" };
      },
    });

    expect(queries).toEqual(["p", "", ""]);
    expect(reloads).toBe(1);
  });

  test("closes from a standalone Escape without waiting for another input chunk", async () => {
    const terminal = new FakeTerminal(["\x1b"], VIEWPORT, true);
    const run = runTerminalPicker({ ...AGENT_PICKER_OPTIONS, prompt: "agents> ", items: STATE.items, terminal });

    const result = await Promise.race([
      run,
      Bun.sleep(100).then(() => "timed-out" as const),
    ]);
    terminal.finish();
    await run;

    expect(result).toBeUndefined();
  });

  test("combines an arrow sequence split across input chunks", async () => {
    const terminal = new FakeTerminal(["\x1b", "[A", "\r"]);

    const result = await runTerminalPicker({
      ...AGENT_PICKER_OPTIONS,
      prompt: "agents> ",
      items: STATE.items,
      focusedId: "codex",
      terminal,
    });

    expect(result?.target).toBe("pane-1");
  });

  test("restores raw mode even when terminal cleanup output fails", async () => {
    const terminal = new FakeTerminal(["\x03"], VIEWPORT, false, true);

    expect(await runTerminalPicker({ ...AGENT_PICKER_OPTIONS, prompt: "agents> ", items: STATE.items, terminal })).toBeUndefined();
    expect(terminal.rawModes).toEqual([true, false]);
  });

  test("restores terminal state after ranker and reloader failures", async () => {
    const rankTerminal = new FakeTerminal(["p"]);
    const reloadTerminal = new FakeTerminal(["\x12"]);

    await expect(runTerminalPicker({
      ...AGENT_PICKER_OPTIONS,
      prompt: "agents> ",
      items: STATE.items,
      terminal: rankTerminal,
      ranker: async () => { throw new Error("rank failed"); },
    })).rejects.toThrow("rank failed");
    await expect(runTerminalPicker({
      ...AGENT_PICKER_OPTIONS,
      prompt: "agents> ",
      items: STATE.items,
      terminal: reloadTerminal,
      reload: async () => { throw new Error("reload failed"); },
    })).rejects.toThrow("reload failed");

    expect(rankTerminal.rawModes).toEqual([true, false]);
    expect(reloadTerminal.rawModes).toEqual([true, false]);
    expect(rankTerminal.writes.join("")).toContain("\x1b[?1049l");
    expect(reloadTerminal.writes.join("")).toContain("\x1b[?1049l");
  });

  test("renders the full list without scheduling an animation interval", async () => {
    const terminal = new FakeTerminal([], TALL_VIEWPORT, true);
    const timers = new FakeTimers();
    const run = runTerminalPicker({ ...AGENT_PICKER_OPTIONS, prompt: "agents> ", items: STATE.items, terminal, timers });

    expect(plain(terminal.writes.at(-1) ?? "")).toContain("main ▸ pi");
    expect(plain(terminal.writes.at(-1) ?? "")).toContain("feat ▸ codex");
    expect(timers.activeCount()).toBe(0);
    terminal.finish();
    await run;
  });

  test("coalesces overlapping periodic reloads", async () => {
    const terminal = new FakeTerminal([], VIEWPORT, true);
    const timers = new FakeTimers();
    const resolvers: Array<(rows: { readonly items: readonly PickerItem[] }) => void> = [];
    let reloads = 0;
    const run = runTerminalPicker({
      ...AGENT_PICKER_OPTIONS,
      prompt: "agents> ",
      items: STATE.items,
      terminal,
      timers,
      refreshIntervalMilliseconds: REFRESH_INTERVAL_MILLISECONDS,
      reload: async () => {
        reloads += 1;
        return new Promise((resolve) => resolvers.push(resolve));
      },
    });

    timers.fire(REFRESH_INTERVAL_MILLISECONDS);
    timers.fire(REFRESH_INTERVAL_MILLISECONDS);
    timers.fire(REFRESH_INTERVAL_MILLISECONDS);
    expect(reloads).toBe(1);

    resolvers.shift()?.({ items: STATE.items });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(reloads).toBe(2);

    resolvers.shift()?.({ items: STATE.items });
    await Promise.resolve();
    terminal.finish();
    await run;
    expect(timers.activeCount()).toBe(0);
  });

  test("redraws immediately after a periodic reload", async () => {
    const terminal = new FakeTerminal([], VIEWPORT, true);
    const timers = new FakeTimers();
    let resolveReload!: (rows: { readonly items: readonly PickerItem[] }) => void;
    const run = runTerminalPicker({
      ...AGENT_PICKER_OPTIONS,
      prompt: "agents> ",
      items: STATE.items,
      terminal,
      timers,
      refreshIntervalMilliseconds: REFRESH_INTERVAL_MILLISECONDS,
      reload: () => new Promise((resolve) => { resolveReload = resolve; }),
    });

    timers.fire(REFRESH_INTERVAL_MILLISECONDS);
    resolveReload({ items: [{ ...ITEMS[0]!, display: "  ✓ main ▸ refreshed" }] });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(plain(terminal.writes.at(-1) ?? "")).toContain("main ▸ refreshed");

    terminal.finish();
    await run;
  });

  test("discards stale query results after a periodic reload", async () => {
    const terminal = new FakeTerminal(["p", "\x03"]);
    const timers = new FakeTimers();
    const oldItem: PickerItem = { id: "agent", searchText: "pi", display: "old pi", target: "old-pane" };
    const refreshedItem: PickerItem = { id: "agent", searchText: "pi", display: "refreshed pi", target: "new-pane" };
    let resolveOldRank!: (items: PickerItem[]) => void;
    let markOldRankStarted!: () => void;
    const oldRankStarted = new Promise<void>((resolve) => { markOldRankStarted = resolve; });
    const run = runTerminalPicker({
      ...AGENT_PICKER_OPTIONS,
      prompt: "agents> ",
      items: [oldItem],
      terminal,
      timers,
      refreshIntervalMilliseconds: REFRESH_INTERVAL_MILLISECONDS,
      reload: async () => ({ items: [refreshedItem] }),
      ranker: async (query, items) => {
        if (query === "p" && items[0]?.target === oldItem.target) {
          markOldRankStarted();
          return new Promise((resolve) => { resolveOldRank = resolve; });
        }
        return [...items];
      },
    });

    await oldRankStarted;
    timers.fire(REFRESH_INTERVAL_MILLISECONDS);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    resolveOldRank([oldItem]);
    await run;
    const latestFrame = terminal.writes.filter((write) => write.includes("\x1b[2J")).at(-1) ?? "";

    expect(plain(latestFrame)).toContain("refreshed pi");
    expect(plain(latestFrame)).not.toContain("old pi");
  });

  test("preserves navigation while periodic ranking is in flight", async () => {
    let sendDown!: (value: string) => void;
    let sendClose!: (value: string) => void;
    const downInput = new Promise<string>((resolve) => { sendDown = resolve; });
    const closeInput = new Promise<string>((resolve) => { sendClose = resolve; });
    const terminal = new FakeTerminal([downInput, closeInput]);
    const timers = new FakeTimers();
    const oldItems: PickerItem[] = [
      { id: "alpha", searchText: "alpha", display: "old alpha", target: "old-alpha" },
      { id: "beta", searchText: "beta", display: "old beta", target: "old-beta" },
    ];
    const refreshedItems: PickerItem[] = [
      { id: "alpha", searchText: "alpha", display: "new alpha", target: "new-alpha" },
      { id: "beta", searchText: "beta", display: "new beta", target: "new-beta" },
    ];
    let resolveRefreshRank!: (items: PickerItem[]) => void;
    let markRefreshRankStarted!: () => void;
    const refreshRankStarted = new Promise<void>((resolve) => { markRefreshRankStarted = resolve; });
    const run = runTerminalPicker({
      ...AGENT_PICKER_OPTIONS,
      prompt: "agents> ",
      items: oldItems,
      terminal,
      timers,
      refreshIntervalMilliseconds: REFRESH_INTERVAL_MILLISECONDS,
      reload: async () => ({ items: refreshedItems }),
      ranker: async (_query, items) => {
        if (items[0]?.target === refreshedItems[0]?.target) {
          markRefreshRankStarted();
          return new Promise((resolve) => { resolveRefreshRank = resolve; });
        }
        return [...items];
      },
    });

    timers.fire(REFRESH_INTERVAL_MILLISECONDS);
    await refreshRankStarted;
    sendDown("\x1b[B");
    await Promise.resolve();
    await Promise.resolve();
    resolveRefreshRank(refreshedItems);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    const latestFrame = plain(terminal.writes.filter((write) => write.includes("\x1b[2J")).at(-1) ?? "");

    expect(latestFrame).toContain("→ new beta");
    expect(latestFrame).not.toContain("→ new alpha");

    sendClose("\x03");
    await run;
  });
});
