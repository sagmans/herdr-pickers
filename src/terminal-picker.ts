import { DEFAULT_PICKER_KEYMAP, type PickerKeymap } from "./config/config.ts";
import { rankRows } from "./fzf.ts";
import {
  arrangePickerItems,
  type PickerItem,
  type PickerRows,
} from "./picker-row.ts";
import {
  ESCAPE_KEY_SEQUENCE,
  parseInput,
  type InputEvent,
} from "./terminal-picker-input.ts";
import {
  fitSelection,
  initialSelection,
  mouseAction,
  moveSelection,
  renderFrame,
  scrollRows,
  type PickerState,
  type Viewport,
} from "./terminal-picker-view.ts";

export { parseInput } from "./terminal-picker-input.ts";
export type { InputEvent, MouseEvent, ParsedInput } from "./terminal-picker-input.ts";
export { mouseAction, renderFrame } from "./terminal-picker-view.ts";
export type { PickerAction, PickerState, Viewport } from "./terminal-picker-view.ts";

const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;
const ESCAPE_SEQUENCE_TIMEOUT_MILLISECONDS = 25;
const LOADING_MESSAGE = "Loading…";
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
const CURSOR_POSITION_SUFFIX = "H";
const CSI_PREFIX = "\x1b[";
const FIRST_TERMINAL_CELL = 1;
const ESCAPE_INPUT_EVENT: InputEvent = { type: "escape" };
const TERMINAL_START = `${ALTERNATE_SCREEN_ENTER}${LINE_WRAP_DISABLE}${MOUSE_TRACKING_ENABLE}${SGR_MOUSE_ENABLE}`;
const TERMINAL_STOP = `${SGR_MOUSE_DISABLE}${MOUSE_TRACKING_DISABLE}${LINE_WRAP_ENABLE}${CURSOR_SHOW}${ALTERNATE_SCREEN_EXIT}`;

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
  readonly keymap?: PickerKeymap | undefined;
  readonly terminal?: TerminalAdapter | undefined;
  readonly ranker?: ((query: string, items: readonly PickerItem[]) => Promise<PickerItem[]>) | undefined;
  readonly reload?: (() => Promise<PickerRows>) | undefined;
  readonly loadOnStart?: boolean | undefined;
  readonly now?: (() => number) | undefined;
  readonly timers?: PickerTimers | undefined;
  readonly refreshIntervalMilliseconds?: number | undefined;
}

export async function runTerminalPicker(options: TerminalPickerOptions): Promise<PickerItem | undefined> {
  const terminal = options.terminal ?? systemTerminal();
  const keymap = options.keymap ?? DEFAULT_PICKER_KEYMAP;
  const ranker = options.ranker ?? rankRows;
  const now = options.now ?? Date.now;
  const timers = options.timers ?? SYSTEM_TIMERS;
  let sourceItems = [...options.items];
  let focusedId = options.focusedId;
  let state = fitSelection({
    prompt: options.prompt,
    noun: options.noun,
    live: options.live,
    emptyMessage: options.loadOnStart === true ? LOADING_MESSAGE : options.emptyMessage,
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
    // Loading copy is placeholder-only: once rows arrive, emptiness is real.
    state = { ...state, emptyMessage: options.emptyMessage, sourceCount: sourceItems.length };
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
        case "reload":
          await refresh();
          break;
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
        default: {
          const exhaustive: never = event;
          return exhaustive;
        }
      }
      if (done) return { done, selection };
      draw();
    }
    return { done: false };
  };

  let iterator: AsyncIterator<string | Uint8Array> | undefined;
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
    // First frame must precede discovery; loading failures ride the same
    // failure channel as timer refreshes so cleanup stays on one path.
    if (options.loadOnStart === true) void refresh().catch(failFromTimer);

    iterator = terminal.input[Symbol.asyncIterator]();
    let nextInput = iterator.next();
    while (true) {
      let input: IteratorResult<string | Uint8Array>;
      if (pending.startsWith(ESCAPE_KEY_SEQUENCE)) {
        const raced = await Promise.race([
          nextInput.then((result) => ({ type: "input" as const, result })),
          Bun.sleep(ESCAPE_SEQUENCE_TIMEOUT_MILLISECONDS).then(() => ({ type: "timeout" as const })),
          timerFailure,
        ]);
        if (raced.type === "timeout") {
          if (pending !== ESCAPE_KEY_SEQUENCE) continue;
          pending = "";
          const outcome = await handleEvents([ESCAPE_INPUT_EVENT]);
          if (outcome.done) return outcome.selection;
          continue;
        }
        input = raced.result;
      } else {
        input = await Promise.race([nextInput, timerFailure]);
      }
      if (input.done) {
        if (pending === ESCAPE_KEY_SEQUENCE) {
          const outcome = await handleEvents([ESCAPE_INPUT_EVENT]);
          if (outcome.done) return outcome.selection;
        }
        return undefined;
      }
      const chunk = input.value;
      pending += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
      const parsed = parseInput(pending, keymap);
      pending = parsed.remainder;
      const outcome = await handleEvents(parsed.events);
      if (outcome.done) return outcome.selection;
      nextInput = iterator.next();
    }
  } finally {
    cleanup();
    // Escape timeout leaves a pending read. Awaiting return() hung Escape while
    // Ctrl-C had no pending read and still dismissed.
    try {
      void iterator?.return?.();
    } catch {}
  }
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
      if (enabled) {
        process.stdin.resume();
        process.stdin.ref();
      } else {
        process.stdin.pause();
        process.stdin.unref();
      }
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
