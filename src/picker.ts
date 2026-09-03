import { Herdr, type CommandRunner } from "./client/herdr.ts";
import { readAgentList, readWorkspaces, readWorktreeScope } from "./client/types.ts";
import { buildAgentTargets, currentContextFromEnv, type AgentTarget, type CurrentContext } from "./catalog.ts";
import type { HerdrPickersConfig } from "./config/config.ts";
import { dispatchAgent, dispatchNavigationTarget } from "./dispatch.ts";
import { loadNavigationTargets, type NavigationMode } from "./navigation.ts";
import type { PickerItem } from "./picker-row.ts";
import { renderAgentRows, renderNavigationRows } from "./rows.ts";
import { runTerminalPicker, type TerminalPickerOptions } from "./terminal-picker.ts";
import { canonicalPathKey } from "./util/paths.ts";

const AGENT_REFRESH_INTERVAL_MILLISECONDS = 1000;
const AGENT_NOUN = "agents";
const NO_AGENTS_MESSAGE = "No agents found.";
const VALID_MODES = "all, projects, workspaces, repo-workspaces, worktrees, repo-worktrees, agents, repo-agents";

const NAVIGATION_PRESENTATION: Readonly<Record<NavigationMode, {
  readonly prompt: string;
  readonly noun: string;
  readonly emptyMessage: string;
}>> = {
  all: { prompt: "all › ", noun: "targets", emptyMessage: "No navigation targets found." },
  projects: { prompt: "projects › ", noun: "projects", emptyMessage: "No projects found." },
  workspaces: { prompt: "workspaces › ", noun: "workspaces", emptyMessage: "No workspaces found." },
  "repo-workspaces": { prompt: "repo workspaces › ", noun: "workspaces", emptyMessage: "No repository workspaces found." },
  worktrees: { prompt: "worktrees › ", noun: "worktrees", emptyMessage: "No worktrees found." },
  "repo-worktrees": { prompt: "repo worktrees › ", noun: "worktrees", emptyMessage: "No repository worktrees found." },
};

export type AgentMode = "agents" | "repo-agents";
export type PickerMode = NavigationMode | AgentMode;

export class AgentTargetError extends Error {
  constructor(readonly observedKeys: readonly string[]) {
    super(`Herdr returned agents without a stable focus target. Expected one of: target, terminal_id, pane_id, unique name, or unique label. Observed keys: ${observedKeys.join(", ") || "none"}`);
    this.name = "AgentTargetError";
  }
}

export type PickerRunner = (options: TerminalPickerOptions) => Promise<PickerItem | undefined>;

export interface PickerRuntime {
  readonly herdr: Herdr;
  readonly env?: Record<string, string | undefined> | undefined;
  readonly gitRunner?: CommandRunner | undefined;
  readonly pickerRunner?: PickerRunner | undefined;
  readonly config?: HerdrPickersConfig | undefined;
}

export type PickerOutcome = "dispatched" | "cancelled" | "no-agents";

export function parseMode(value: string | undefined): PickerMode {
  switch (value) {
    case "all":
    case "projects":
    case "workspaces":
    case "repo-workspaces":
    case "worktrees":
    case "repo-worktrees":
    case "agents":
    case "repo-agents":
      return value;
    default:
      throw new Error(`Unknown herdr-pickers mode '${value ?? ""}'. Valid modes: ${VALID_MODES}`);
  }
}

export async function loadAgentTargets(
  mode: AgentMode,
  herdr: Herdr,
  env: Record<string, string | undefined> | undefined,
): Promise<AgentTarget[]> {
  const [workspaces, agentList] = await Promise.all([
    readWorkspaces(await herdr.json(["workspace", "list"])),
    readAgentList(await herdr.json(["agent", "list"])),
  ]);
  if (agentList.agents.length === 0 && agentList.skippedWithoutTarget > 0) {
    throw new AgentTargetError(agentList.observedKeys);
  }
  const current = currentContextFromEnv(env);
  const targets = buildAgentTargets(agentList.agents, workspaces, current, { includeFocused: true });
  if (mode === "repo-agents") {
    const scopeKey = await repositoryScopeKey(workspaces, current, herdr);
    return scopeKey ? targets.filter((target) => target.repoKey === scopeKey) : [];
  }
  return targets;
}

export async function runPicker(mode: PickerMode, runtime: PickerRuntime): Promise<PickerOutcome> {
  return isAgentMode(mode)
    ? runAgentPicker(mode, runtime)
    : runNavigationPicker(mode, runtime);
}

export async function runAgentPicker(mode: AgentMode, runtime: PickerRuntime): Promise<PickerOutcome> {
  const targets = await loadAgentTargets(mode, runtime.herdr, runtime.env);
  if (targets.length === 0) return "no-agents";
  const rendered = renderAgentRows(targets);
  const prompt = mode === "repo-agents" ? "repo agents › " : "agents › ";
  const picker = runtime.pickerRunner ?? runTerminalPicker;
  const selection = await picker({
    prompt,
    noun: AGENT_NOUN,
    live: true,
    emptyMessage: NO_AGENTS_MESSAGE,
    items: rendered.items,
    focusedId: rendered.focusedId,
    keymap: runtime.config?.keymap,
    reload: async () => renderAgentRows(await loadAgentTargets(mode, runtime.herdr, runtime.env)),
    refreshIntervalMilliseconds: AGENT_REFRESH_INTERVAL_MILLISECONDS,
  });
  const target = selection?.target;
  if (!target) return "cancelled";
  await dispatchAgent(target, runtime.herdr);
  return "dispatched";
}

async function runNavigationPicker(mode: NavigationMode, runtime: PickerRuntime): Promise<PickerOutcome> {
  let targets = await loadNavigationTargets(mode, navigationRuntime(runtime));
  const picker = runtime.pickerRunner ?? runTerminalPicker;
  const presentation = NAVIGATION_PRESENTATION[mode];
  const rendered = renderNavigationRows(mode, targets);
  const selection = await picker({
    prompt: presentation.prompt,
    noun: presentation.noun,
    emptyMessage: presentation.emptyMessage,
    items: rendered.items,
    focusedId: rendered.focusedId,
    keymap: runtime.config?.keymap,
    reload: async () => {
      targets = await loadNavigationTargets(mode, navigationRuntime(runtime));
      return renderNavigationRows(mode, targets);
    },
  });
  if (!selection) return "cancelled";
  const target = targets.find((candidate) => candidate.id === selection.target);
  if (!target) throw new Error(`Selected navigation target '${selection.target}' is no longer available.`);
  await dispatchNavigationTarget(target, runtime.herdr);
  return "dispatched";
}

function navigationRuntime(runtime: PickerRuntime) {
  return {
    herdr: runtime.herdr,
    env: runtime.env,
    gitRunner: runtime.gitRunner,
    projectRoots: runtime.config?.projects.roots,
  };
}

function isAgentMode(mode: PickerMode): mode is AgentMode {
  switch (mode) {
    case "agents":
    case "repo-agents":
      return true;
    case "all":
    case "projects":
    case "workspaces":
    case "repo-workspaces":
    case "worktrees":
    case "repo-worktrees":
      return false;
    default: {
      const exhaustive: never = mode;
      return exhaustive;
    }
  }
}

// Repository scope prefers explicit workspace provenance; the worktree list is
// the authoritative fallback when older Herdr records omit it.
async function repositoryScopeKey(
  workspaces: readonly import("./client/types.ts").WorkspaceRecord[],
  current: CurrentContext,
  herdr: Herdr,
): Promise<string | undefined> {
  const source = current.workspaceId
    ? workspaces.find((workspace) => workspace.workspaceId === current.workspaceId)
    : undefined;
  const repoRoot = source?.worktree?.repoRoot;
  if (repoRoot) return canonicalPathKey(repoRoot);
  const repoKey = source?.worktree?.repoKey;
  if (repoKey) return repoKey;
  const lookup = current.workspaceId
    ? ["--workspace", current.workspaceId]
    : current.cwd
      ? ["--cwd", current.cwd]
      : [];
  if (lookup.length === 0) throw new Error("Cannot scope repository agents without a source workspace or cwd.");
  const sourceRoot = readWorktreeScope(await herdr.json(["worktree", "list", ...lookup, "--json"]));
  return sourceRoot ? canonicalPathKey(sourceRoot) : undefined;
}
