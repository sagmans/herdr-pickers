/**
 * Single source of truth for interactive picker modes.
 *
 * Every mode-dependent decision (parsing, presentation, data loading, row
 * layout) reads this table so adding or changing a mode cannot leave one of
 * those layers behind. Key order is the public order used in error messages
 * and must stay aligned with the `herdr-plugin.toml` actions.
 */
import type { TargetKind } from "./catalog.ts";

/** Copy shown by the terminal picker frame for one mode. */
interface ModePresentation {
  readonly prompt: string;
  readonly noun: string;
  readonly emptyMessage: string;
}

/** Navigation modes merge several target kinds into one catalog. */
export interface NavigationModeSpec extends ModePresentation {
  readonly kind: "navigation";
  /** Target kinds the catalog contains, in load order. */
  readonly targetKinds: readonly TargetKind[];
  /** Limits rows to the source workspace's repository. */
  readonly repoScoped: boolean;
  /** Flat lists have no repository header, so identity carries the qualifier. */
  readonly grouped: boolean;
  /** Mixed-kind lists need a kind badge and kind-first ordering to stay readable. */
  readonly kindBadges: boolean;
}

/** Agent modes poll Herdr's live agent list instead of a navigation catalog. */
export interface AgentModeSpec extends ModePresentation {
  readonly kind: "agent";
  /** Limits rows to the source workspace's repository. */
  readonly repoScoped: boolean;
}

export const PICKER_MODES = {
  all: {
    kind: "navigation", prompt: "all › ", noun: "targets", emptyMessage: "No navigation targets found.",
    targetKinds: ["project", "workspace", "worktree"], repoScoped: false, grouped: true, kindBadges: true,
  },
  projects: {
    kind: "navigation", prompt: "projects › ", noun: "projects", emptyMessage: "No projects found.",
    targetKinds: ["project"], repoScoped: false, grouped: false, kindBadges: false,
  },
  workspaces: {
    kind: "navigation", prompt: "workspaces › ", noun: "workspaces", emptyMessage: "No workspaces found.",
    targetKinds: ["workspace"], repoScoped: false, grouped: true, kindBadges: false,
  },
  "repo-workspaces": {
    kind: "navigation", prompt: "repo workspaces › ", noun: "workspaces", emptyMessage: "No repository workspaces found.",
    targetKinds: ["workspace"], repoScoped: true, grouped: true, kindBadges: false,
  },
  worktrees: {
    kind: "navigation", prompt: "worktrees › ", noun: "worktrees", emptyMessage: "No worktrees found.",
    targetKinds: ["worktree"], repoScoped: false, grouped: true, kindBadges: false,
  },
  "repo-worktrees": {
    kind: "navigation", prompt: "repo worktrees › ", noun: "worktrees", emptyMessage: "No repository worktrees found.",
    targetKinds: ["worktree"], repoScoped: true, grouped: true, kindBadges: false,
  },
  agents: {
    kind: "agent", prompt: "agents › ", noun: "agents", emptyMessage: "No agents found.", repoScoped: false,
  },
  "repo-agents": {
    kind: "agent", prompt: "repo agents › ", noun: "agents", emptyMessage: "No agents found.", repoScoped: true,
  },
} as const satisfies Readonly<Record<string, NavigationModeSpec | AgentModeSpec>>;

type ModeTable = typeof PICKER_MODES;
export type PickerMode = keyof ModeTable;
export type NavigationMode = { [M in PickerMode]: ModeTable[M]["kind"] extends "navigation" ? M : never }[PickerMode];
export type AgentMode = { [M in PickerMode]: ModeTable[M]["kind"] extends "agent" ? M : never }[PickerMode];

const VALID_MODES = Object.keys(PICKER_MODES).join(", ");

/** Rejects untrusted action arguments and persisted requests before they select behavior. */
export function parseMode(value: string | undefined): PickerMode {
  if (value !== undefined && Object.hasOwn(PICKER_MODES, value)) return value as PickerMode;
  throw new Error(`Unknown herdr-pickers mode '${value ?? ""}'. Valid modes: ${VALID_MODES}`);
}

export function isAgentMode(mode: PickerMode): mode is AgentMode {
  return PICKER_MODES[mode].kind === "agent";
}

/** Widens the literal table entry so callers can use spec fields generically. */
export function navigationModeSpec(mode: NavigationMode): NavigationModeSpec {
  return PICKER_MODES[mode];
}

/** Widens the literal table entry so callers can use spec fields generically. */
export function agentModeSpec(mode: AgentMode): AgentModeSpec {
  return PICKER_MODES[mode];
}
