import { PICKER_PALETTE } from "./palette.ts";
import type { RgbColor } from "./style.ts";

// Shared state vocabulary preserves Herdr familiarity while palette ownership
// keeps every picker visually coherent.
export type AgentState = "blocked" | "working" | "done" | "idle" | "unknown";

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

export function statusColor(state: AgentState): RgbColor {
  return PICKER_PALETTE.status[state];
}
