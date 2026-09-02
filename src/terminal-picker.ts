import { rankRows } from "./fzf.ts";
import { PICKER_PALETTE } from "./palette.ts";
import { trueColor } from "./style.ts";
import {
  arrangePickerItems,
  expandPickerItems,
  type PickerDisplayRow,
  type PickerItem,
  type PickerRows,
} from "./picker-row.ts";

const CLOSE_BUTTON = "✕";
const CLOSE_ROW = 1;
const CLOSE_RIGHT_MARGIN = 1;
const CLOSE_HIT_RADIUS = 1;
const DIVIDER = "─";
const TOP_DIVIDER_INDEX = 1;
const RAIL_ROWS = 2;
const RESERVED_ROWS = RAIL_ROWS * 2;
const MIN_DIVIDER_VIEWPORT_ROWS = RESERVED_ROWS;
const LIVE_SUFFIX = " · live";
const PLURAL_SUFFIX = "s";
const MATCH_SINGULAR = "match";
const MATCH_PLURAL = "matches";
const POINTER = "→";
const MOUSE_PATTERN = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/;
const CSI_PATTERN = /^\x1b\[[0-9;?]*[ -/]*[@-~]/;
const C1_CSI_PATTERN = /^\u009b[0-9;?]*[ -/]*[@-~]/;
const KEY_UP = "\x1b[A";
const KEY_DOWN = "\x1b[B";
const KEY_ESCAPE = "\x1b";
const KEY_CTRL_C = "\x03";
const KEY_CTRL_N = "\x0e";
const KEY_CTRL_P = "\x10";
const KEY_CTRL_R = "\x12";
const KEY_ENTER = "\r";
const KEY_NEWLINE = "\n";
const KEY_BACKSPACE = "\x7f";
const MOUSE_LEFT = 0;
const MOUSE_WHEEL_UP = 64;
const MOUSE_WHEEL_DOWN = 65;
const PRINTABLE_CODE_MIN = 0x20;
const DELETE_CODE = 0x7f;
const C1_CONTROL_MAX = 0x9f;
const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;
const ESCAPE_SEQUENCE_TIMEOUT_MILLISECONDS = 25;
const DOUBLE_CLICK_MILLISECONDS = 400;
const WHEEL_STEP = 3;
const ALTERNATE_SCREEN_ENTER = "\x1b[?1049h";
const ALTERNATE_SCREEN_EXIT = "\x1b[?1049l";
const MOUSE_TRACKING_ENABLE = "\x1b[?1000h";
const MOUSE_TRACKING_DISABLE = "\x1b[?1000l";
const SGR_MOUSE_ENABLE = "\x1b[?1006h";
const SGR_MOUSE_DISABLE = "\x1b[?1006l";
const LINE_WRAP_DISABLE = "\x1b[?7l";
const LINE_WRAP_ENABLE = "\x1b[?7h";
const CURSOR_HIDE = "\x1b[?25l";
const CURSOR_SHOW = "\x1b[?25h";
const CLEAR_SCREEN = "\x1b[2J";
const CURSOR_HOME = "\x1b[H";
const CURSOR_COLUMN_SUFFIX = "G";
const CURSOR_POSITION_SUFFIX = "H";
const CSI_PREFIX = "\x1b[";
const FIRST_TERMINAL_CELL = 1;
const TERMINAL_START = `${ALTERNATE_SCREEN_ENTER}${LINE_WRAP_DISABLE}${MOUSE_TRACKING_ENABLE}${SGR_MOUSE_ENABLE}`;
const TERMINAL_STOP = `${SGR_MOUSE_DISABLE}${MOUSE_TRACKING_DISABLE}${LINE_WRAP_ENABLE}${CURSOR_SHOW}${ALTERNATE_SCREEN_EXIT}`;

export interface Viewport {
  readonly columns: number;
  readonly rows: number;
}

interface ListLayout {
  readonly count: number;
  readonly firstIndex: number;
  readonly firstRow: number;
  readonly rows: readonly PickerDisplayRow[];
}

export interface PickerState {
  readonly prompt: string;
  readonly noun: string;
  readonly live?: boolean | undefined;
  readonly emptyMessage?: string | undefined;
  readonly query: string;
  readonly items: readonly PickerItem[];
  readonly sourceCount: number;
  readonly selected: number;
  readonly scrollTop: number;
}

export interface MouseEvent {
  readonly type: "mouse";
  readonly button: "left" | "wheel-up" | "wheel-down" | "other";
  readonly column: number;
  readonly row: number;
  readonly released: boolean;
}

export type InputEvent =
  | MouseEvent
  | { readonly type: "up" }
  | { readonly type: "down" }
  | { readonly type: "accept" }
  | { readonly type: "escape" }
  | { readonly type: "close" }
  | { readonly type: "reload" }
  | { readonly type: "backspace" }
  | { readonly type: "text"; readonly value: string };

export type PickerAction =
  | { readonly type: "close" }
  | { readonly type: "select"; readonly index: number }
  | { readonly type: "scroll"; readonly delta: number }
  | { readonly type: "none" };

export interface ParsedInput {
  readonly events: readonly InputEvent[];
  readonly remainder: string;
}

export interface TerminalAdapter {
  readonly input: AsyncIterable<string | Uint8Array>;
  write(value: string): void;
  setRawMode(enabled: boolean): void;
  getViewport(): Viewport;
  onResize(listener: () => void): () => void;
}

export interface PickerTimers {
  readonly setInterval: (callback: () => void, milliseconds: number) => unknown;
  readonly clearInterval: (handle: unknown) => void;
}

const SYSTEM_TIMERS: PickerTimers = {
  setInterval: (callback, milliseconds) => setInterval(callback, milliseconds),
  clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
};

export interface TerminalPickerOptions extends PickerRows {
  readonly prompt: string;
  readonly noun: string;
  readonly live?: boolean | undefined;
  readonly emptyMessage?: string | undefined;
  readonly terminal?: TerminalAdapter | undefined;
  readonly ranker?: ((query: string, items: readonly PickerItem[]) => Promise<PickerItem[]>) | undefined;
  readonly reload?: (() => Promise<PickerRows>) | undefined;
  readonly now?: (() => number) | undefined;
  readonly timers?: PickerTimers | undefined;
  readonly refreshIntervalMilliseconds?: number | undefined;
}

export function renderFrame(state: PickerState, viewport: Viewport): readonly string[] {
  if (viewport.rows <= 0) return [];
  const frame = Array.from({ length: viewport.rows }, () => "");
  frame[0] = `${trueColor(PICKER_PALETTE.muted, sourceCountLabel(state.sourceCount, state.noun, state.live))}${CSI_PREFIX}${closeColumn(viewport)}${CURSOR_COLUMN_SUFFIX}${trueColor(PICKER_PALETTE.muted, CLOSE_BUTTON)}`;
  if (viewport.rows === 1) return frame;

  if (hasDividers(viewport)) {
    const divider = trueColor(PICKER_PALETTE.muted, DIVIDER.repeat(Math.max(0, viewport.columns)));
    frame[TOP_DIVIDER_INDEX] = divider;
    frame[viewport.rows - RAIL_ROWS] = divider;
  }

  const list = listLayout(state, viewport);
  for (let offset = 0; offset < list.count; offset += 1) {
    const row = list.rows[list.firstIndex + offset];
    if (row === undefined) break;
    const selected = row.type === "item" && row.itemIndex === state.selected;
    const selectionColor = row.type === "item" ? row.item.selectionColor ?? PICKER_PALETTE.selected : PICKER_PALETTE.selected;
    const pointer = selected ? trueColor(selectionColor, POINTER) : " ";
    const display = row.type === "group"
      ? row.group.display
      : selected
        ? row.item.selectedDisplay ?? row.item.display
        : row.item.display;
    frame[list.firstRow - 1 + offset] = `${pointer} ${display}`;
  }
  if (state.items.length === 0 && state.emptyMessage !== undefined && resultCapacity(viewport) > 0) {
    frame[resultEndRow(viewport) - RAIL_ROWS] = state.emptyMessage;
  }
  frame[viewport.rows - 1] = promptRail(state, viewport);
  return frame;
}

export function mouseAction(event: MouseEvent, state: PickerState, viewport: Viewport): PickerAction {
  if (event.released) return { type: "none" };
  if (event.button === "wheel-up") return { type: "scroll", delta: -1 };
  if (event.button === "wheel-down") return { type: "scroll", delta: 1 };
  if (event.button !== "left") return { type: "none" };
  if (event.row === CLOSE_ROW && Math.abs(event.column - closeColumn(viewport)) <= CLOSE_HIT_RADIUS) {
    return { type: "close" };
  }
  const list = listLayout(state, viewport);
  if (event.row < list.firstRow || event.row >= list.firstRow + list.count) return { type: "none" };
  const row = list.rows[list.firstIndex + event.row - list.firstRow];
  return row?.type === "item" ? { type: "select", index: row.itemIndex } : { type: "none" };
}

export function parseInput(data: string): ParsedInput {
  const events: InputEvent[] = [];
  let remaining = data;

  while (remaining.length > 0) {
    const mouse = MOUSE_PATTERN.exec(remaining);
    if (mouse) {
      events.push({
        type: "mouse",
        button: mouseButton(Number(mouse[1])),
        column: Number(mouse[2]),
        row: Number(mouse[3]),
        released: mouse[4] === "m",
      });
      remaining = remaining.slice(mouse[0].length);
      continue;
    }
    if (remaining.startsWith("\x1b[<")) return { events, remainder: remaining };
    if (remaining.startsWith(KEY_UP)) {
      events.push({ type: "up" });
      remaining = remaining.slice(KEY_UP.length);
      continue;
    }
    if (remaining.startsWith(KEY_DOWN)) {
      events.push({ type: "down" });
      remaining = remaining.slice(KEY_DOWN.length);
      continue;
    }
    const csi = CSI_PATTERN.exec(remaining);
    if (csi) {
      remaining = remaining.slice(csi[0].length);
      continue;
    }
    const c1Csi = C1_CSI_PATTERN.exec(remaining);
    if (c1Csi) {
      remaining = remaining.slice(c1Csi[0].length);
      continue;
    }
    if (remaining.startsWith("\x1b[") && remaining.length < KEY_UP.length) {
      return { events, remainder: remaining };
    }
    if (remaining === KEY_ESCAPE) return { events, remainder: remaining };

    const character = Array.from(remaining)[0];
    if (character === undefined) break;
    remaining = remaining.slice(character.length);
    switch (character) {
      case KEY_ESCAPE:
        events.push({ type: "escape" });
        break;
      case KEY_CTRL_C:
        events.push({ type: "close" });
        break;
      case KEY_CTRL_N:
        events.push({ type: "down" });
        break;
      case KEY_CTRL_P:
        events.push({ type: "up" });
        break;
      case KEY_CTRL_R:
        events.push({ type: "reload" });
        break;
      case KEY_ENTER:
      case KEY_NEWLINE:
        events.push({ type: "accept" });
        break;
      case KEY_BACKSPACE:
        events.push({ type: "backspace" });
        break;
      default:
        if (isPrintable(character)) events.push({ type: "text", value: character });
    }
  }

  return { events, remainder: "" };
}

export async function runTerminalPicker(options: TerminalPickerOptions): Promise<PickerItem | undefined> {
  const terminal = options.terminal ?? systemTerminal();
  const ranker = options.ranker ?? rankRows;
  const now = options.now ?? Date.now;
  const timers = options.timers ?? SYSTEM_TIMERS;
  let sourceItems = [...options.items];
  let focusedId = options.focusedId;
  let state = fitSelection({
    prompt: options.prompt,
    noun: options.noun,
    live: options.live,
    emptyMessage: options.emptyMessage,
    query: "",
    items: arrangePickerItems(sourceItems),
    sourceCount: sourceItems.length,
    selected: initialSelection(sourceItems, focusedId),
    scrollTop: 0,
  }, terminal.getViewport());
  let pending = "";
  const decoder = new TextDecoder();
  let rawMode = false;
  let removeResizeListener = (): void => {};
  let cleaned = false;
  let refreshRunning: Promise<void> | undefined;
  let refreshPending = false;
  let rankRevision = 0;
  let timerFailureRaised = false;
  let rejectTimerFailure!: (error: unknown) => void;
  const timerFailure = new Promise<never>((_resolve, reject) => { rejectTimerFailure = reject; });
  const intervalHandles: unknown[] = [];
  let previousClick: { readonly itemId: string; readonly time: number } | undefined;

  const draw = (): void => drawFrame(terminal, state);
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    for (const handle of intervalHandles) {
      try {
        timers.clearInterval(handle);
      } catch {}
    }
    try {
      removeResizeListener();
    } catch {}
    try {
      terminal.write(TERMINAL_STOP);
    } catch {}
    if (rawMode) {
      try {
        terminal.setRawMode(false);
      } catch {}
      rawMode = false;
    }
  };
  const failFromTimer = (error: unknown): void => {
    if (cleaned || timerFailureRaised) return;
    timerFailureRaised = true;
    rejectTimerFailure(error);
  };
  const applyQuery = async (query: string): Promise<void> => {
    previousClick = undefined;
    // An unchanged query is a live refresh: keep the pointer where the user
    // put it. A changed query is typing: best match wins, and an empty query
    // returns to the focused/current row.
    const preserveSelection = query === state.query;
    state = { ...state, query };
    const revision = ++rankRevision;
    let items: PickerItem[];
    try {
      items = arrangePickerItems(await ranker(query, sourceItems));
    } catch (error) {
      if (revision !== rankRevision || cleaned) return;
      throw error;
    }
    if (revision !== rankRevision || cleaned) return;
    let selected = query.length === 0
      ? initialSelection(items, focusedId)
      : items.length === 0 ? -1 : 0;
    if (preserveSelection) {
      const selectedItem = state.items[state.selected];
      const previous = selectedItem === undefined ? -1 : items.findIndex((item) => item.id === selectedItem.id);
      if (previous >= 0) selected = previous;
    }
    state = fitSelection({ ...state, query, items, selected }, terminal.getViewport());
  };
  const reloadRows = async (): Promise<void> => {
    if (!options.reload) return;
    const rows = await options.reload();
    sourceItems = [...rows.items];
    focusedId = rows.focusedId;
    state = { ...state, sourceCount: sourceItems.length };
    await applyQuery(state.query);
    if (!cleaned) draw();
  };
  const refresh = (): Promise<void> => {
    if (refreshRunning) {
      refreshPending = true;
      return refreshRunning;
    }
    const run = (async (): Promise<void> => {
      try {
        do {
          refreshPending = false;
          await reloadRows();
        } while (refreshPending && !cleaned);
      } finally {
        refreshRunning = undefined;
      }
    })();
    refreshRunning = run;
    return run;
  };
  const handleEvents = async (events: readonly InputEvent[]): Promise<{ readonly done: boolean; readonly selection?: PickerItem | undefined }> => {
    for (const event of events) {
      let selection: PickerItem | undefined;
      let done = false;
      switch (event.type) {
        case "close":
          done = true;
          break;
        case "escape":
          if (state.query.length === 0) {
            done = true;
          } else {
            await applyQuery("");
          }
          break;
        case "accept":
          selection = state.items[state.selected];
          done = selection !== undefined;
          break;
        case "up":
          previousClick = undefined;
          state = moveSelection(state, -1, terminal.getViewport());
          break;
        case "down":
          previousClick = undefined;
          state = moveSelection(state, 1, terminal.getViewport());
          break;
        case "backspace":
          await applyQuery(Array.from(state.query).slice(0, -1).join(""));
          break;
        case "text":
          await applyQuery(state.query + event.value);
          break;
        case "reload": {
          await refresh();
          break;
        }
        case "mouse": {
          const action = mouseAction(event, state, terminal.getViewport());
          if (action.type === "close") {
            done = true;
          } else if (action.type === "scroll") {
            previousClick = undefined;
            state = scrollRows(state, action.delta * WHEEL_STEP, terminal.getViewport());
          } else if (action.type === "select") {
            const clickedAt = now();
            const clickedItem = state.items[action.index];
            if (clickedItem !== undefined && previousClick?.itemId === clickedItem.id && clickedAt - previousClick.time <= DOUBLE_CLICK_MILLISECONDS) {
              selection = clickedItem;
              done = true;
            } else {
              state = fitSelection({ ...state, selected: action.index }, terminal.getViewport());
              if (clickedItem !== undefined) previousClick = { itemId: clickedItem.id, time: clickedAt };
            }
          }
          break;
        }
      }
      if (done) return { done, selection };
      draw();
    }
    return { done: false };
  };

  try {
    terminal.setRawMode(true);
    rawMode = true;
    terminal.write(TERMINAL_START);
    removeResizeListener = terminal.onResize(() => {
      state = fitSelection(state, terminal.getViewport());
      draw();
    });
    if (options.reload && options.refreshIntervalMilliseconds !== undefined) {
      intervalHandles.push(timers.setInterval(() => {
        void refresh().catch(failFromTimer);
      }, options.refreshIntervalMilliseconds));
    }
    draw();

    const iterator = terminal.input[Symbol.asyncIterator]();
    let nextInput = iterator.next();
    while (true) {
      let input: IteratorResult<string | Uint8Array>;
      if (pending.startsWith(KEY_ESCAPE)) {
          const raced = await Promise.race([
            nextInput.then((result) => ({ type: "input" as const, result })),
            Bun.sleep(ESCAPE_SEQUENCE_TIMEOUT_MILLISECONDS).then(() => ({ type: "timeout" as const })),
            timerFailure,
          ]);
        if (raced.type === "timeout") {
          const events: InputEvent[] = pending === KEY_ESCAPE ? [{ type: "escape" }] : [];
          pending = "";
          const outcome = await handleEvents(events);
          if (outcome.done) return outcome.selection;
          continue;
        }
        input = raced.result;
      } else {
        input = await Promise.race([nextInput, timerFailure]);
      }
      if (input.done) {
        if (pending === KEY_ESCAPE) {
          const outcome = await handleEvents([{ type: "escape" }]);
          if (outcome.done) return outcome.selection;
        }
        return undefined;
      }
      const chunk = input.value;
      pending += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
      const parsed = parseInput(pending);
      pending = parsed.remainder;
      const outcome = await handleEvents(parsed.events);
      if (outcome.done) return outcome.selection;
      nextInput = iterator.next();
    }
  } finally {
    cleanup();
  }
}

function mouseButton(code: number): MouseEvent["button"] {
  switch (code) {
    case MOUSE_LEFT:
      return "left";
    case MOUSE_WHEEL_UP:
      return "wheel-up";
    case MOUSE_WHEEL_DOWN:
      return "wheel-down";
    default:
      return "other";
  }
}

function isPrintable(value: string): boolean {
  const code = value.codePointAt(0);
  return code !== undefined && code >= PRINTABLE_CODE_MIN && (code < DELETE_CODE || code > C1_CONTROL_MAX);
}

function closeColumn(viewport: Viewport): number {
  return Math.max(1, viewport.columns - CLOSE_RIGHT_MARGIN);
}

function listLayout(state: PickerState, viewport: Viewport): ListLayout {
  const rows = expandPickerItems(state.items);
  const capacity = resultCapacity(viewport);
  const count = Math.min(capacity, Math.max(0, rows.length - state.scrollTop));
  return {
    count,
    firstIndex: state.scrollTop,
    firstRow: resultEndRow(viewport) - count,
    rows,
  };
}

function hasDividers(viewport: Viewport): boolean {
  return viewport.rows >= MIN_DIVIDER_VIEWPORT_ROWS;
}

function resultCapacity(viewport: Viewport): number {
  return Math.max(0, viewport.rows - (hasDividers(viewport) ? RESERVED_ROWS : RAIL_ROWS));
}

function resultEndRow(viewport: Viewport): number {
  return viewport.rows - (hasDividers(viewport) ? 1 : 0);
}

function sourceCountLabel(count: number, noun: string, live: boolean | undefined): string {
  const countNoun = count === 1 && noun.endsWith(PLURAL_SUFFIX) ? noun.slice(0, -PLURAL_SUFFIX.length) : noun;
  return `${count} ${countNoun}${live === true ? LIVE_SUFFIX : ""}`;
}

function promptRail(state: PickerState, viewport: Viewport): string {
  const left = `${trueColor(PICKER_PALETTE.group, state.prompt)}${state.query}`;
  const count = state.items.length;
  const rightLabel = `${count} ${count === 1 ? MATCH_SINGULAR : MATCH_PLURAL}`;
  const rightColumn = Math.max(1, viewport.columns - Bun.stringWidth(rightLabel) + 1);
  const leftWidth = Bun.stringWidth(state.prompt + state.query);
  if (leftWidth >= rightColumn) return left;
  return `${left}${CSI_PREFIX}${rightColumn}${CURSOR_COLUMN_SUFFIX}${trueColor(PICKER_PALETTE.muted, rightLabel)}`;
}

function systemTerminal(): TerminalAdapter {
  return {
    input: process.stdin,
    write: (value) => {
      process.stdout.write(value);
    },
    setRawMode: (enabled) => {
      if (!process.stdin.isTTY) throw new Error("Agent picker requires a TTY.");
      process.stdin.setRawMode(enabled);
      if (enabled) process.stdin.resume();
      else process.stdin.pause();
    },
    getViewport: () => ({
      columns: process.stdout.columns ?? DEFAULT_COLUMNS,
      rows: process.stdout.rows ?? DEFAULT_ROWS,
    }),
    onResize: (listener) => {
      process.stdout.on("resize", listener);
      return () => process.stdout.off("resize", listener);
    },
  };
}

function drawFrame(terminal: TerminalAdapter, state: PickerState): void {
  const viewport = terminal.getViewport();
  const frame = renderFrame(state, viewport);
  terminal.write(`${CURSOR_HIDE}${CLEAR_SCREEN}${CURSOR_HOME}${frame.join("\r\n")}${searchCursorPosition(state, viewport)}${CURSOR_SHOW}`);
}

function searchCursorPosition(state: PickerState, viewport: Viewport): string {
  const row = Math.max(FIRST_TERMINAL_CELL, viewport.rows);
  const lastColumn = Math.max(FIRST_TERMINAL_CELL, viewport.columns);
  const column = Math.min(lastColumn, Bun.stringWidth(state.prompt + state.query) + FIRST_TERMINAL_CELL);
  return `${CSI_PREFIX}${row};${column}${CURSOR_POSITION_SUFFIX}`;
}

function initialSelection(items: readonly PickerItem[], focusedId?: string): number {
  if (items.length === 0) return -1;
  if (focusedId === undefined) return 0;
  const focused = items.findIndex((item) => item.id === focusedId);
  return focused >= 0 ? focused : 0;
}

function moveSelection(state: PickerState, delta: number, viewport: Viewport): PickerState {
  if (state.items.length === 0) return state;
  return fitSelection({
    ...state,
    selected: Math.min(state.items.length - 1, Math.max(0, state.selected + delta)),
  }, viewport);
}

function scrollRows(state: PickerState, delta: number, viewport: Viewport): PickerState {
  const rows = expandPickerItems(state.items);
  const capacity = resultCapacity(viewport);
  if (capacity === 0 || rows.length <= capacity) return state;
  const maxScroll = rows.length - capacity;
  const scrollTop = Math.min(maxScroll, Math.max(0, state.scrollTop + delta));
  const selectedRow = rows.findIndex((row) => row.type === "item" && row.itemIndex === state.selected);
  const visibleItems = rows.slice(scrollTop, scrollTop + capacity).filter((row) => row.type === "item");
  const selected = selectedRow < scrollTop
    ? visibleItems[0]?.itemIndex ?? state.selected
    : selectedRow >= scrollTop + capacity
      ? visibleItems.at(-1)?.itemIndex ?? state.selected
      : state.selected;
  return { ...state, selected, scrollTop };
}

function fitSelection(state: PickerState, viewport: Viewport): PickerState {
  const rows = expandPickerItems(state.items);
  const capacity = resultCapacity(viewport);
  if (state.items.length === 0 || capacity === 0) return { ...state, selected: -1, scrollTop: 0 };
  const selected = Math.min(state.items.length - 1, Math.max(0, state.selected));
  const selectedRow = rows.findIndex((row) => row.type === "item" && row.itemIndex === selected);
  const maxScroll = Math.max(0, rows.length - capacity);
  let scrollTop = Math.min(maxScroll, Math.max(0, state.scrollTop));
  if (selectedRow < scrollTop) scrollTop = selectedRow;
  if (selectedRow >= scrollTop + capacity) scrollTop = selectedRow - capacity + 1;
  return { ...state, selected, scrollTop };
}
