import type { RgbColor } from "./style.ts";

interface PickerPalette {
  readonly group: RgbColor;
  readonly selected: RgbColor;
  readonly current: RgbColor;
  readonly identity: RgbColor;
  readonly muted: RgbColor;
  readonly status: {
    readonly blocked: RgbColor;
    readonly working: RgbColor;
    readonly done: RgbColor;
    readonly idle: RgbColor;
    readonly unknown: RgbColor;
  };
  readonly kind: {
    readonly project: RgbColor;
    readonly workspace: RgbColor;
    readonly worktree: RgbColor;
  };
}

// One RGB authority prevents terminal-default ANSI mappings from fragmenting
// picker appearance across modes and terminal emulators.
export const PICKER_PALETTE: PickerPalette = {
  group: { red: 217, green: 139, blue: 182 },
  selected: { red: 139, green: 217, blue: 174 },
  current: { red: 139, green: 217, blue: 174 },
  identity: { red: 216, green: 216, blue: 216 },
  muted: { red: 115, green: 122, blue: 162 },
  status: {
    blocked: { red: 247, green: 118, blue: 142 },
    working: { red: 224, green: 175, blue: 104 },
    done: { red: 125, green: 207, blue: 255 },
    idle: { red: 158, green: 206, blue: 106 },
    unknown: { red: 115, green: 122, blue: 162 },
  },
  kind: {
    project: { red: 158, green: 206, blue: 106 },
    workspace: { red: 122, green: 162, blue: 247 },
    worktree: { red: 255, green: 158, blue: 100 },
  },
};
