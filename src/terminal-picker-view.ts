import { PICKER_PALETTE } from "./palette.ts";
import {
  expandPickerItems,
  type PickerDisplayRow,
  type PickerItem,
} from "./picker-row.ts";
import { trueColor } from "./style.ts";
import type { MouseEvent } from "./terminal-picker-input.ts";

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
const CURSOR_COLUMN_SUFFIX = "G";
const CSI_PREFIX = "\x1b[";

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

export type PickerAction =
  | { readonly type: "close" }
  | { readonly type: "select"; readonly index: number }
  | { readonly type: "scroll"; readonly delta: number }
  | { readonly type: "none" };

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

export function initialSelection(items: readonly PickerItem[], focusedId?: string): number {
  if (items.length === 0) return -1;
  if (focusedId === undefined) return 0;
  const focused = items.findIndex((item) => item.id === focusedId);
  return focused >= 0 ? focused : 0;
}

export function moveSelection(state: PickerState, delta: number, viewport: Viewport): PickerState {
  if (state.items.length === 0) return state;
  return fitSelection({
    ...state,
    selected: Math.min(state.items.length - 1, Math.max(0, state.selected + delta)),
  }, viewport);
}

export function scrollRows(state: PickerState, delta: number, viewport: Viewport): PickerState {
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

export function fitSelection(state: PickerState, viewport: Viewport): PickerState {
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
