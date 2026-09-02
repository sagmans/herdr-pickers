import type { RgbColor } from "./style.ts";

export interface PickerGroup {
  readonly key: string;
  readonly label: string;
  readonly display: string;
}

export interface PickerItem {
  readonly id: string;
  readonly searchText: string;
  readonly display: string;
  readonly selectedDisplay?: string | undefined;
  readonly selectionColor?: RgbColor | undefined;
  readonly target: string;
  readonly group?: PickerGroup | undefined;
}

export interface PickerRows {
  readonly items: readonly PickerItem[];
  readonly focusedId?: string | undefined;
}

export type PickerDisplayRow =
  | { readonly type: "group"; readonly group: PickerGroup }
  | { readonly type: "item"; readonly item: PickerItem; readonly itemIndex: number };

const GROUP_BUCKET_PREFIX = "group:";
const ITEM_BUCKET_PREFIX = "item:";

export function arrangePickerItems(items: readonly PickerItem[]): PickerItem[] {
  const buckets = new Map<string, PickerItem[]>();
  for (const item of items) {
    const key = item.group ? GROUP_BUCKET_PREFIX + item.group.key : ITEM_BUCKET_PREFIX + item.id;
    buckets.set(key, [...(buckets.get(key) ?? []), item]);
  }
  return [...buckets.values()].flat();
}

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
