// Mode-neutral row model shared by row rendering (rows.ts), fzf ranking, and
// the terminal picker. Keeps grouping and ordering rules out of mode code.
import type { RgbColor } from "./style.ts";

/** Repository header; `key` identifies the group, `label`/`display` are sanitized visible text. */
export interface PickerGroup {
  readonly key: string;
  readonly label: string;
  readonly display: string;
}

/** One selectable row. `searchText` and displays are visible; `id` and `target` are hidden dispatch keys. */
export interface PickerItem {
  readonly id: string;
  readonly searchText: string;
  readonly display: string;
  readonly selectedDisplay?: string | undefined;
  readonly selectionColor?: RgbColor | undefined;
  readonly target: string;
  readonly group?: PickerGroup | undefined;
}

/** Rendered rows plus the row the cursor should start on, if any. */
export interface PickerRows {
  readonly items: readonly PickerItem[];
  readonly focusedId?: string | undefined;
}

/** Screen line: either a group header or an item with its index in the ranked list. */
export type PickerDisplayRow =
  | { readonly type: "group"; readonly group: PickerGroup }
  | { readonly type: "item"; readonly item: PickerItem; readonly itemIndex: number };

const GROUP_BUCKET_PREFIX = "group:";
const ITEM_BUCKET_PREFIX = "item:";

/** Keeps each group contiguous after fzf ranking, ordered by its best-ranked member. */
export function arrangePickerItems(items: readonly PickerItem[]): PickerItem[] {
  const buckets = new Map<string, PickerItem[]>();
  for (const item of items) {
    const key = item.group ? GROUP_BUCKET_PREFIX + item.group.key : ITEM_BUCKET_PREFIX + item.id;
    buckets.set(key, [...(buckets.get(key) ?? []), item]);
  }
  return [...buckets.values()].flat();
}

/** Inserts group headers for the view; the offset keeps item indexes aligned when rendering a slice. */
export function expandPickerItems(items: readonly PickerItem[], itemIndexOffset = 0): PickerDisplayRow[] {
  const rows: PickerDisplayRow[] = [];
  let previousGroupKey: string | undefined;
  items.forEach((item, itemIndex) => {
    if (item.group && item.group.key !== previousGroupKey) rows.push({ type: "group", group: item.group });
    rows.push({ type: "item", item, itemIndex: itemIndex + itemIndexOffset });
    previousGroupKey = item.group?.key;
  });
  return rows;
}
