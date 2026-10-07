import { Herdr, type CommandRunner } from "./client/herdr.ts";
import { readAgentList, readWorkspaces, readWorktreeScope, type WorkspaceRecord } from "./client/types.ts";
import { buildAgentTargets, type AgentTarget } from "./catalog.ts";
import type { CurrentContext } from "./context.ts";
import type { HerdrPickersConfig } from "./config/config.ts";
import { dispatchAgent, dispatchNavigationTarget } from "./dispatch.ts";
import { agentModeSpec, isAgentMode, navigationModeSpec, type AgentMode, type NavigationMode, type PickerMode } from "./modes.ts";
import { loadNavigationTargets, type NavigationTarget } from "./navigation.ts";
import type { PickerItem } from "./picker-row.ts";
import { renderAgentRows, renderNavigationRows } from "./rows.ts";
import { runTerminalPicker, type TerminalPickerOptions } from "./terminal-picker.ts";
import { canonicalPathKey } from "./util/paths.ts";

const AGENT_REFRESH_INTERVAL_MILLISECONDS = 1000;

export class AgentTargetError extends Error {
  constructor(readonly observedKeys: readonly string[]) {
    super(`Herdr returned agents without a stable focus target. Expected one of: target, terminal_id, pane_id, unique name, or unique label. Observed keys: ${observedKeys.join(", ") || "none"}`);
    this.name = "AgentTargetError";
  }
}

export type PickerRunner = (options: TerminalPickerOptions) => Promise<PickerItem | undefined>;

export interface PickerRuntime {
  readonly signal?: AbortSignal | undefined;
  readonly beforeDispatch?: (() => void | Promise<void>) | undefined;
  readonly beforeCleanup?: (() => Promise<void>) | undefined;
  readonly herdr: Herdr;
  /** Surface the picker was opened from; absent means no source to mark or scope by. */
  readonly context?: CurrentContext | undefined;
  /** Only locates plugin configuration; source context never travels through it. */
  readonly env?: Record<string, string | undefined> | undefined;
  readonly gitRunner?: CommandRunner | undefined;
  readonly pickerRunner?: PickerRunner | undefined;
  readonly config?: HerdrPickersConfig | undefined;
}

export type PickerOutcome = "dispatched" | "cancelled" | "no-agents";

export async function loadAgentTargets(
  mode: AgentMode,
  herdr: Herdr,
  current: CurrentContext = {},
): Promise<AgentTarget[]> {
  // Both Herdr round-trips start before either is awaited so the 1s agent
  // refresh pays one call latency instead of two.
  const [workspaceEnvelope, agentEnvelope] = await Promise.all([
    herdr.json(["workspace", "list"]),
    herdr.json(["agent", "list"]),
  ]);
  const workspaces = readWorkspaces(workspaceEnvelope);
  const agentList = readAgentList(agentEnvelope);
  if (agentList.agents.length === 0 && agentList.skippedWithoutTarget > 0) {
    throw new AgentTargetError(agentList.observedKeys);
  }
  const targets = buildAgentTargets(agentList.agents, workspaces, current, { includeFocused: true });
  if (agentModeSpec(mode).repoScoped) {
    const scopeKey = await repositoryScopeKey(workspaces, current, herdr);
    return scopeKey ? targets.filter((target) => target.repoKey === scopeKey) : [];
  }
  return targets;
}

export async function runPicker(mode: PickerMode, runtime: PickerRuntime): Promise<PickerOutcome> {
  if (runtime.signal?.aborted) return "cancelled";
  try {
    return await (isAgentMode(mode) ? runAgentPicker(mode, runtime) : runNavigationPicker(mode, runtime));
  } catch (error) {
    if (runtime.signal?.aborted) return "cancelled";
    throw error;
  }
}

export async function runAgentPicker(mode: AgentMode, runtime: PickerRuntime): Promise<PickerOutcome> {
  if (runtime.signal?.aborted) return "cancelled";
  const loading = new AbortController();
  const signal = runtime.signal ? AbortSignal.any([runtime.signal, loading.signal]) : loading.signal;
  let initialLoad = true;
  let noAgents = false;
  const presentation = agentModeSpec(mode);
  const picker = runtime.pickerRunner ?? runTerminalPicker;
  let dispatched = false;
  try {
    await picker({
      prompt: presentation.prompt,
      signal,
      beforeCleanup: runtime.beforeCleanup,
      noun: presentation.noun,
      live: true,
      emptyMessage: presentation.emptyMessage,
      items: [],
      loadOnStart: true,
      keymap: runtime.config?.keymap,
      reload: async () => {
        signal.throwIfAborted();
        const targets = await loadAgentTargets(mode, runtime.herdr, runtime.context);
        signal.throwIfAborted();
        // Initial emptiness still dismisses the picker; later refreshes may recover.
        if (initialLoad && targets.length === 0) {
          noAgents = true;
          loading.abort();
        }
        initialLoad = false;
        return renderAgentRows(targets);
      },
      refreshIntervalMilliseconds: AGENT_REFRESH_INTERVAL_MILLISECONDS,
      onAccept: async selection => {
        if (runtime.signal?.aborted) return;
        await runtime.beforeDispatch?.();
        if (runtime.signal?.aborted) return;
        await dispatchAgent(selection.target, runtime.herdr);
        dispatched = true;
      },
    });
  } finally {
    loading.abort();
  }
  return noAgents ? "no-agents" : dispatched ? "dispatched" : "cancelled";
}

async function runNavigationPicker(mode: NavigationMode, runtime: PickerRuntime): Promise<PickerOutcome> {
  // Discovery stays off the first-frame path: the popup draws immediately and
  // the startup load rides the same reload path as manual Ctrl-r refreshes.
  let targets: NavigationTarget[] = [];
  const picker = runtime.pickerRunner ?? runTerminalPicker;
  const presentation = navigationModeSpec(mode);
  const loadRows = async () => {
    runtime.signal?.throwIfAborted();
    const loaded = await loadNavigationTargets(mode, navigationRuntime(runtime));
    runtime.signal?.throwIfAborted();
    targets = loaded;
    return renderNavigationRows(mode, targets);
  };
  let dispatched = false;
  await picker({
    prompt: presentation.prompt,
    signal: runtime.signal,
    beforeCleanup: runtime.beforeCleanup,
    noun: presentation.noun,
    emptyMessage: presentation.emptyMessage,
    items: [],
    loadOnStart: true,
    keymap: runtime.config?.keymap,
    reload: loadRows,
    onAccept: async selection => {
      if (runtime.signal?.aborted) return;
      const target = targets.find((candidate) => candidate.id === selection.target);
      if (!target) throw new Error(`Selected navigation target '${selection.target}' is no longer available.`);
      await runtime.beforeDispatch?.();
      if (runtime.signal?.aborted) return;
      await dispatchNavigationTarget(target, runtime.herdr);
      dispatched = true;
    },
  });
  return dispatched ? "dispatched" : "cancelled";
}

function navigationRuntime(runtime: PickerRuntime) {
  return {
    herdr: runtime.herdr,
    context: runtime.context,
    env: runtime.env,
    gitRunner: runtime.gitRunner,
    projectRoots: runtime.config?.projects.roots,
    signal: runtime.signal,
  };
}

// Repository scope prefers explicit workspace provenance; the worktree list is
// the authoritative fallback when older Herdr records omit it.
async function repositoryScopeKey(
  workspaces: readonly WorkspaceRecord[],
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
