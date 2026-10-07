import { DEFAULT_PICKER_KEYMAP, type PickerKeymap } from "./config/config.ts";
import { rankRows } from "./fzf.ts";
import {
  arrangePickerItems,
  type PickerItem,
  type PickerRows,
} from "./picker-row.ts";
import { CURSOR_SHOW, type TerminalLease } from "./picker-terminal.ts";
import { InputFramer, type InputEvent } from "./terminal-picker-input.ts";
import { reduceInteraction, type InteractionState } from "./terminal-picker-state.ts";
import {
  fitSelection,
  initialSelection,
  renderFrame,
  type PickerState,
  type Viewport,
} from "./terminal-picker-view.ts";

const ESCAPE_SEQUENCE_TIMEOUT_MILLISECONDS = 25;
const LOADING_MESSAGE = "Loading…";
const CURSOR_HIDE = "\x1b[?25l";
const CLEAR_SCREEN = "\x1b[2J";
const CURSOR_HOME = "\x1b[H";
const CURSOR_POSITION_SUFFIX = "H";
const CSI_PREFIX = "\x1b[";
const FIRST_TERMINAL_CELL = 1;

export interface PickerTimers {
  readonly setInterval: (callback: () => void, milliseconds: number) => unknown;
  readonly clearInterval: (handle: unknown) => void;
}

const SYSTEM_TIMERS: PickerTimers = {
  setInterval: (callback, milliseconds) => setInterval(callback, milliseconds),
  clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
};

/** What a mode asks of the picker; the terminal is supplied separately by its owner. */
export interface PickerOptions extends PickerRows {
  readonly signal?: AbortSignal | undefined;
  readonly onAccept?: ((selection: PickerItem) => Promise<void>) | undefined;
  readonly prompt: string;
  readonly noun: string;
  readonly live?: boolean | undefined;
  readonly emptyMessage?: string | undefined;
  readonly keymap?: PickerKeymap | undefined;
  readonly ranker?: ((query: string, items: readonly PickerItem[]) => Promise<PickerItem[]>) | undefined;
  readonly reload?: (() => Promise<PickerRows>) | undefined;
  readonly loadOnStart?: boolean | undefined;
  readonly now?: (() => number) | undefined;
  readonly timers?: PickerTimers | undefined;
  readonly refreshIntervalMilliseconds?: number | undefined;
}

export interface TerminalPickerOptions extends PickerOptions {
  /** Borrowed from PickerTerminal, which alone restores the device afterwards. */
  readonly terminal: TerminalLease;
}

type Outcome = { readonly done: false } | { readonly done: true; readonly selection?: PickerItem | undefined };
const CONTINUE: Outcome = { done: false };
const CLOSED: Outcome = { done: true };

/**
 * Runs one picker mode on a borrowed terminal until selection, dismissal, or
 * cancellation. Terminal modes are not touched here: leaving the frame drawn
 * lets the owner dismiss the surface before the primary screen returns.
 */
export async function runTerminalPicker(options: TerminalPickerOptions): Promise<PickerItem | undefined> {
  if (options.signal?.aborted) return undefined;
  const { terminal, signal } = options;
  const keymap = options.keymap ?? DEFAULT_PICKER_KEYMAP;
  const ranker = options.ranker ?? ((query, items) => rankRows(query, items, signal));
  const now = options.now ?? Date.now;
  const timers = options.timers ?? SYSTEM_TIMERS;
  const framer = new InputFramer(terminal.inputState, keymap);
  const failure = failureChannel();
  const intervalHandles: unknown[] = [];
  let rows: PickerRows = { items: [...options.items], focusedId: options.focusedId };
  let interaction: InteractionState = {
    view: fitSelection({
      prompt: options.prompt,
      noun: options.noun,
      live: options.live,
      emptyMessage: options.loadOnStart === true ? LOADING_MESSAGE : options.emptyMessage,
      query: "",
      items: arrangePickerItems(rows.items),
      sourceCount: rows.items.length,
      selected: initialSelection(rows.items, rows.focusedId),
      scrollTop: 0,
    }, terminal.getViewport()),
  };
  // "accepting" freezes the selected frame until the destination owns focus.
  let phase: "running" | "accepting" | "closed" = "running";
  let rankRevision = 0;
  let removeResizeListener = (): void => {};

  const idle = (): boolean => phase !== "running" || signal?.aborted === true;
  const draw = (): void => {
    if (!idle()) drawFrame(terminal, interaction.view);
  };
  const close = (): void => {
    if (phase === "closed") return;
    phase = "closed";
    rankRevision++;
    for (const handle of intervalHandles) {
      try {
        timers.clearInterval(handle);
      } catch {}
    }
    try {
      removeResizeListener();
    } catch {}
  };
  const failFromBackground = (error: unknown): void => {
    // An accepted handoff ignores late refresh errors unless cancellation intervened.
    if (phase === "closed" || (phase === "accepting" && !signal?.aborted)) return;
    failure.fail(error);
  };
  const applyQuery = async (query: string): Promise<void> => {
    if (idle()) return;
    // An unchanged query is a live refresh: keep the pointer where the user
    // put it. A changed query is typing: best match wins, and an empty query
    // returns to the focused/current row.
    const preserveSelection = query === interaction.view.query;
    interaction = { view: { ...interaction.view, query } };
    const revision = ++rankRevision;
    let items: PickerItem[];
    try {
      items = arrangePickerItems(await ranker(query, rows.items));
    } catch (error) {
      if (revision !== rankRevision || phase === "closed") return;
      throw error;
    }
    if (revision !== rankRevision || phase === "closed") return;
    const view = interaction.view;
    let selected = query.length === 0
      ? initialSelection(items, rows.focusedId)
      : items.length === 0 ? -1 : 0;
    if (preserveSelection) {
      const selectedItem = view.items[view.selected];
      const previous = selectedItem === undefined ? -1 : items.findIndex((item) => item.id === selectedItem.id);
      if (previous >= 0) selected = previous;
    }
    interaction = { ...interaction, view: fitSelection({ ...view, query, items, selected }, terminal.getViewport()) };
  };
  const reloadRows = async (): Promise<void> => {
    if (!options.reload || idle()) return;
    const loaded = await options.reload();
    if (idle()) return;
    rows = { items: [...loaded.items], focusedId: loaded.focusedId };
    // Loading copy is placeholder-only: once rows arrive, emptiness is real.
    interaction = { ...interaction, view: { ...interaction.view, emptyMessage: options.emptyMessage, sourceCount: rows.items.length } };
    await applyQuery(interaction.view.query);
    draw();
  };
  const refresh = coalesce(reloadRows, () => phase !== "closed");
  const handleEvents = async (events: readonly InputEvent[]): Promise<Outcome> => {
    for (const event of events) {
      if (phase === "closed" || signal?.aborted) return CLOSED;
      const step = reduceInteraction(interaction, event, { viewport: terminal.getViewport(), now });
      interaction = step.state;
      const { effect } = step;
      switch (effect.type) {
        case "none":
          break;
        case "close":
          return CLOSED;
        case "accept":
          phase = "accepting";
          rankRevision++;
          await options.onAccept?.(effect.selection);
          return { done: true, selection: effect.selection };
        case "query":
          await applyQuery(effect.query);
          break;
        case "reload":
          await refresh();
          break;
        default: {
          const exhaustive: never = effect;
          return exhaustive;
        }
      }
      draw();
    }
    return CONTINUE;
  };
  // Background failures (timers, cancellation) interrupt whichever await is pending.
  const settle = (events: readonly InputEvent[]): Promise<Outcome> => Promise.race([handleEvents(events), failure.promise]);

  let iterator: AsyncIterator<string> | undefined;
  const abort = (): void => failFromBackground(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  try {
    removeResizeListener = terminal.onResize(() => {
      interaction = { ...interaction, view: fitSelection(interaction.view, terminal.getViewport()) };
      draw();
    });
    if (options.reload && options.refreshIntervalMilliseconds !== undefined) {
      intervalHandles.push(timers.setInterval(() => {
        void refresh().catch(failFromBackground);
      }, options.refreshIntervalMilliseconds));
    }
    draw();
    // First frame must precede discovery; loading failures ride the same
    // failure channel as timer refreshes so cleanup stays on one path.
    if (options.loadOnStart === true) void refresh().catch(failFromBackground);

    iterator = terminal.input[Symbol.asyncIterator]();
    let nextInput = iterator.next();
    while (true) {
      const raced = await Promise.race([
        nextInput.then((result) => ({ type: "input" as const, result })),
        // A buffered Escape is ambiguous until its continuation arrives or this window lapses.
        ...(framer.awaitingEscape
          ? [Bun.sleep(ESCAPE_SEQUENCE_TIMEOUT_MILLISECONDS).then(() => ({ type: "timeout" as const }))]
          : []),
        failure.promise,
      ]);
      const events = raced.type === "timeout"
        ? framer.expireEscape()
        : raced.result.done ? framer.finalEvents() : framer.feed(raced.result.value);
      const outcome = events.length > 0 ? await settle(events) : CONTINUE;
      if (outcome.done) return outcome.selection;
      if (raced.type === "input") {
        if (raced.result.done) return undefined;
        nextInput = iterator.next();
      }
    }
  } catch (error) {
    if (signal?.aborted) return undefined;
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
    framer.save();
    close();
    // A pending Escape read must not delay teardown.
    try {
      void iterator?.return?.();
    } catch {}
  }
}

/** One-shot rejection that lets background work interrupt the foreground loop. */
function failureChannel(): { readonly promise: Promise<never>; fail(error: unknown): void } {
  let raised = false;
  let reject!: (error: unknown) => void;
  const promise = new Promise<never>((_resolve, rejectPromise) => { reject = rejectPromise; });
  return {
    promise,
    fail: (error) => {
      if (raised) return;
      raised = true;
      reject(error);
    },
  };
}

/**
 * Single-flight with one trailing rerun: overlapping timer ticks and Ctrl-r
 * presses share a reload instead of stacking Herdr queries.
 */
function coalesce(task: () => Promise<void>, active: () => boolean): () => Promise<void> {
  let running: Promise<void> | undefined;
  let again = false;
  return () => {
    if (running) {
      again = true;
      return running;
    }
    const run = (async (): Promise<void> => {
      try {
        do {
          again = false;
          await task();
        } while (again && active());
      } finally {
        running = undefined;
      }
    })();
    running = run;
    return run;
  };
}

function drawFrame(terminal: TerminalLease, state: PickerState): void {
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
