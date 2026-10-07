// Runs one picker mode end to end: catalog load, rows, terminal interaction, and
// dispatch. Agent modes poll for live state; navigation modes reload on demand.
// The picker loop (picker-loop.ts) drives mode replacement around it.
import { loadAgentTargets } from "./agents.ts";
import type { Herdr } from "./client/herdr.ts";
import type { CurrentContext } from "./context.ts";
import type { HerdrPickersConfig } from "./config/config.ts";
import { dispatchAgent, dispatchNavigationTarget } from "./dispatch.ts";
import { agentModeSpec, isAgentMode, navigationModeSpec, type AgentMode, type NavigationMode, type PickerMode } from "./modes.ts";
import { loadNavigationTargets, type NavigationTarget } from "./navigation.ts";
import type { PickerItem } from "./picker-row.ts";
import { renderAgentRows, renderNavigationRows } from "./rows.ts";
import type { PickerOptions } from "./terminal-picker.ts";
import type { CommandRunner } from "./util/subprocess.ts";

const AGENT_REFRESH_INTERVAL_MILLISECONDS = 1000;

/** Supplies the terminal for one mode; the picker loop binds it to the session-wide PickerTerminal. */
export type PickerRunner = (options: PickerOptions) => Promise<PickerItem | undefined>;

/** Dependencies for one mode run; injected so tests and the loop control Herdr, Git, and the terminal. */
export interface PickerRuntime {
  readonly signal?: AbortSignal | undefined;
  readonly beforeDispatch?: (() => void | Promise<void>) | undefined;
  readonly herdr: Herdr;
  /** Surface the picker was opened from; absent means no source to mark or scope by. */
  readonly context?: CurrentContext | undefined;
  /** Only locates plugin configuration; source context never travels through it. */
  readonly env?: Record<string, string | undefined> | undefined;
  readonly gitRunner?: CommandRunner | undefined;
  readonly pickerRunner: PickerRunner;
  readonly config?: HerdrPickersConfig | undefined;
}

/** "no-agents" lets the pane print an empty-state message after the picker closes itself. */
export type PickerOutcome = "dispatched" | "cancelled" | "no-agents";

/** Failures after the run signal aborts are reported as cancellation, not errors. */
export async function runPicker(mode: PickerMode, runtime: PickerRuntime): Promise<PickerOutcome> {
  if (runtime.signal?.aborted) return "cancelled";
  try {
    return await (isAgentMode(mode) ? runAgentPicker(mode, runtime) : runNavigationPicker(mode, runtime));
  } catch (error) {
    if (runtime.signal?.aborted) return "cancelled";
    throw error;
  }
}

/** Polling agent picker; an empty first load dismisses it with "no-agents" instead of an empty frame. */
export async function runAgentPicker(mode: AgentMode, runtime: PickerRuntime): Promise<PickerOutcome> {
  if (runtime.signal?.aborted) return "cancelled";
  const loading = new AbortController();
  const signal = runtime.signal ? AbortSignal.any([runtime.signal, loading.signal]) : loading.signal;
  let initialLoad = true;
  let noAgents = false;
  const presentation = agentModeSpec(mode);
  const picker = runtime.pickerRunner;
  let dispatched = false;
  try {
    await picker({
      prompt: presentation.prompt,
      signal,
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
  const picker = runtime.pickerRunner;
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
