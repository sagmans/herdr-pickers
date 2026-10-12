// Agent status vocabulary for the agent picker. Normalizes Herdr's free-form
// status into a closed set so rows.ts can pick glyphs and palette.ts colors
// exhaustively.
import { PICKER_PALETTE } from "./palette.ts";
import type { RgbColor } from "./style.ts";

// Shared state vocabulary preserves Herdr familiarity while palette ownership
// keeps every picker visually coherent.
export type AgentState = "blocked" | "working" | "done" | "idle" | "unknown";

/** Untrusted Herdr status strings outside the known set collapse to "unknown" instead of failing the row. */
export function parseAgentStatus(status: string | undefined): AgentState {
  switch (status) {
    case "blocked":
    case "working":
    case "done":
    case "idle":
      return status;
    default:
      return "unknown";
  }
}

/** Glyph shape stays distinct for idle/unknown so state remains readable without color. */
export function statusGlyph(state: AgentState): string {
  switch (state) {
    case "blocked":
      return "●";
    case "working":
      return "●";
    case "done":
      return "●";
    case "idle":
      return "○";
    case "unknown":
      return "·";
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}

/** Status colors come from the shared palette so agent rows match every other picker. */
export function statusColor(state: AgentState): RgbColor {
  return PICKER_PALETTE.status[state];
}
