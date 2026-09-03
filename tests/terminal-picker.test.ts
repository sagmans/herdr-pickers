import { describe, expect, test } from "bun:test";

import { parseConfig } from "../src/config/config.ts";
import type { PickerGroup, PickerItem } from "../src/picker-row.ts";
import { runTerminalPicker, type PickerState } from "../src/terminal-picker.ts";
import {
  FakeTerminal,
  FakeTimers,
  TALL_VIEWPORT,
  VIEWPORT,
} from "./terminal-picker-test-support.ts";

const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const REFRESH_INTERVAL_MILLISECONDS = 1000;
const CONFIG_PATH = "/example/config.toml";
const KEY_CTRL_C = "\x03";
const KEY_CTRL_J = "\x0a";
const KEY_ENTER = "\r";
const KEY_ESCAPE = "\x1b";
const CSI_PREFIX = "\x1b[";
const KEY_UP_FINAL = "A";
const DELAYED_SEQUENCE_MILLISECONDS = 75;
const VIM_KEYMAP_TOML = '[keymap]\nup = ["up", "ctrl-k"]\ndown = ["down", "ctrl-j"]\n';
const BACKGROUND_FAILURE_TIMEOUT_MILLISECONDS = 100;
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

  test("moves with a configured key before accepting", async () => {
    const terminal = new FakeTerminal([KEY_CTRL_J, KEY_ENTER]);
    const keymap = parseConfig(VIM_KEYMAP_TOML, CONFIG_PATH).keymap;

    const result = await runTerminalPicker({
      ...AGENT_PICKER_OPTIONS,
      prompt: "agents> ",
      items: STATE.items,
      terminal,
      keymap,
    });

    expect(result?.target).toBe("pane-2");
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
    const terminal = new FakeTerminal([KEY_ESCAPE, "[A", KEY_ENTER]);

    const result = await runTerminalPicker({
      ...AGENT_PICKER_OPTIONS,
      prompt: "agents> ",
      items: STATE.items,
      focusedId: "codex",
      terminal,
    });

    expect(result?.target).toBe("pane-1");
  });

  test("retains a fragmented arrow after the Escape timeout", async () => {
    const delayedTail = Bun.sleep(DELAYED_SEQUENCE_MILLISECONDS).then(() => KEY_UP_FINAL);
    const terminal = new FakeTerminal([CSI_PREFIX, delayedTail, KEY_ENTER]);

    const result = await runTerminalPicker({
      ...AGENT_PICKER_OPTIONS,
      prompt: "agents> ",
      items: STATE.items,
      focusedId: "codex",
      terminal,
    });

    expect(result?.target).toBe("pane-1");
  });

  test("keeps Escape and Ctrl-C fixed outside the configurable keymap", async () => {
    const delayedClose = Bun.sleep(DELAYED_SEQUENCE_MILLISECONDS).then(() => KEY_CTRL_C);
    const terminal = new FakeTerminal(["p", KEY_ESCAPE, delayedClose]);
    const queries: string[] = [];

    const result = await runTerminalPicker({
      ...AGENT_PICKER_OPTIONS,
      prompt: "agents> ",
      items: STATE.items,
      terminal,
      keymap: new Map<string, never>(),
      ranker: async (query, items) => {
        queries.push(query);
        return [...items];
      },
    });

    expect(result).toBeUndefined();
    expect(queries).toEqual(["p", ""]);
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
test("keeps input responsive while the initial reload is pending", async () => {
    let sendQuery!: (value: string) => void;
    let sendAccept!: (value: string) => void;
    let resolveReload!: (rows: { readonly items: readonly PickerItem[]; readonly focusedId?: string }) => void;
    let markEmptyQueryRanked!: () => void;
    let markLoadedQueryRanked!: () => void;
    const queryInput = new Promise<string>((resolve) => { sendQuery = resolve; });
    const acceptInput = new Promise<string>((resolve) => { sendAccept = resolve; });
    const emptyQueryRanked = new Promise<void>((resolve) => { markEmptyQueryRanked = resolve; });
    const loadedQueryRanked = new Promise<void>((resolve) => { markLoadedQueryRanked = resolve; });
    const terminal = new FakeTerminal([queryInput, acceptInput]);
    const loaded: PickerItem = {
      id: "workspace:beta",
      searchText: "beta",
      display: "beta",
      target: "workspace:beta",
    };

    const run = runTerminalPicker({
      prompt: "workspaces › ",
      noun: "workspaces",
      emptyMessage: "No workspaces found.",
      items: [],
      loadOnStart: true,
      terminal,
      reload: () => new Promise((resolve) => { resolveReload = resolve; }),
      ranker: async (query, items) => {
        if (query === "beta" && items.length === 0) markEmptyQueryRanked();
        if (query === "beta" && items.length === 1) markLoadedQueryRanked();
        return items.filter((item) => item.searchText.includes(query));
      },
    });

    expect(plain(terminal.writes.at(-1) ?? "")).toContain("Loading…");
    sendQuery("beta");
    await emptyQueryRanked;
    resolveReload({ items: [loaded], focusedId: loaded.id });
    await loadedQueryRanked;
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    sendAccept("\r");

    expect((await run)?.target).toBe(loaded.target);
  });

  test("replaces loading copy with the configured empty message", async () => {
    const terminal = new FakeTerminal([], VIEWPORT, true);
    const run = runTerminalPicker({
      prompt: "workspaces › ",
      noun: "workspaces",
      emptyMessage: "No workspaces found.",
      items: [],
      loadOnStart: true,
      terminal,
      reload: async () => ({ items: [] }),
    });

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    const latestFrame = plain(terminal.writes.filter((write) => write.includes("\x1b[2J")).at(-1) ?? "");
    expect(latestFrame).toContain("No workspaces found.");
    expect(latestFrame).not.toContain("Loading…");

    terminal.finish();
    await run;
  });

  test("restores terminal state after an initial reload failure", async () => {
    const terminal = new FakeTerminal([], VIEWPORT, true);
    const run = runTerminalPicker({
      prompt: "workspaces › ",
      noun: "workspaces",
      emptyMessage: "No workspaces found.",
      items: [],
      loadOnStart: true,
      terminal,
      reload: async () => { throw new Error("initial load failed"); },
    });
    const outcome = await Promise.race([
      run.then(
        () => ({ type: "resolved" as const }),
        (error: unknown) => ({ type: "rejected" as const, error }),
      ),
      Bun.sleep(BACKGROUND_FAILURE_TIMEOUT_MILLISECONDS).then(() => ({ type: "timed-out" as const })),
    ]);

    terminal.finish();
    await run.catch(() => {});
    expect(outcome.type).toBe("rejected");
    if (outcome.type !== "rejected") throw new Error("picker did not reject");
    expect(outcome.error).toBeInstanceOf(Error);
    expect((outcome.error as Error).message).toBe("initial load failed");
    expect(terminal.rawModes).toEqual([true, false]);
    expect(terminal.writes.join("")).toContain("\x1b[?1049l");
  });
});

