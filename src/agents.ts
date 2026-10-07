/**
 * Live agent catalog for agent picker modes. It reloads on every refresh tick,
 * so it keeps Herdr round-trips minimal and stays separate from the
 * reload-on-demand navigation catalog.
 */
import type { Herdr } from "./client/herdr.ts";
import { readAgentList, readWorkspaces } from "./client/types.ts";
import { buildAgentTargets, type AgentTarget } from "./catalog.ts";
import type { CurrentContext } from "./context.ts";
import { resolveSourceRepositoryKey } from "./discovery/worktrees.ts";
import { agentModeSpec, type AgentMode } from "./modes.ts";

// Without a stable target an accepted row could focus the wrong agent, so the
// picker reports Herdr's shape instead of guessing.
export class AgentTargetError extends Error {
  constructor(readonly observedKeys: readonly string[]) {
    super(`Herdr returned agents without a stable focus target. Expected one of: target, terminal_id, pane_id, unique name, or unique label. Observed keys: ${observedKeys.join(", ") || "none"}`);
    this.name = "AgentTargetError";
  }
}

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
    const scopeKey = await resolveSourceRepositoryKey(workspaces, current, herdr);
    return scopeKey ? targets.filter((target) => target.repoKey === scopeKey) : [];
  }
  return targets;
}
