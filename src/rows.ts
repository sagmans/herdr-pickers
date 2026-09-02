import { dirname, parse, sep } from "node:path";

import { parseAgentStatus, statusColor, statusGlyph, type AgentState } from "./agent-status.ts";
import type { AgentTarget, PickerTarget, TargetKind } from "./catalog.ts";
import type { NavigationMode } from "./navigation.ts";
import { PICKER_PALETTE } from "./palette.ts";
import type { PickerGroup, PickerItem, PickerRows } from "./picker-row.ts";
import { bold, dim, trueColor } from "./style.ts";
import { sanitizeTerminalText } from "./util/terminal-text.ts";

const UNKNOWN_REPO = "unknown repo";
const UNKNOWN_REPO_KEY = "\0unknown repo";
const GROUP_QUALIFIER_SEPARATOR = " · ";
const RELATION_SEPARATOR = " ▸ ";
const GROUP_PREFIX = "▾ ";
const CURRENT_MARKER = "●";
const CURRENT_MARKER_SUFFIX = " ";
const SEARCH_FIELD_SEPARATOR = " ";
const KIND_PRIORITY: Readonly<Record<TargetKind, number>> = {
  project: 0,
  workspace: 1,
  worktree: 2,
};

interface RepositoryTarget {
  readonly repo?: string | undefined;
  readonly repoKey?: string | undefined;
}

interface NavigationQualifiers {
  readonly repositories: ReadonlyMap<string, string>;
  readonly workspaces: ReadonlyMap<string, string>;
}

export function renderAgentRows(targets: readonly AgentTarget[]): PickerRows {
  const ordered = orderAgents(targets);
  const qualifiers = repositoryQualifiers(ordered);
  const items: PickerItem[] = [];
  let focusedId: string | undefined;
  let previousRepoKey: string | undefined;
  let group: PickerGroup | undefined;

  for (const target of ordered) {
    const repoKey = target.repoKey ?? UNKNOWN_REPO_KEY;
    if (repoKey !== previousRepoKey) {
      const label = repoLabel(target, qualifiers);
      group = {
        key: repoKey,
        label,
        display: renderGroup(label, target.repo === undefined),
      };
      previousRepoKey = repoKey;
    }
    const state = parseAgentStatus(target.status);
    const display = renderTargetLine(target, state, false);
    items.push({
      id: target.id,
      searchText: [group?.label, target.worktree ? sanitize(target.worktree) : undefined, sanitize(target.agentLabel)].filter(Boolean).join(SEARCH_FIELD_SEPARATOR),
      display,
      selectedDisplay: renderTargetLine(target, state, true),
      selectionColor: statusColor(state),
      target: target.agentTarget,
      group,
    });
    if (focusedId === undefined && target.focused) focusedId = target.id;
  }

  return { items, focusedId };
}

export function renderNavigationRows(
  mode: NavigationMode,
  targets: readonly PickerTarget[],
): PickerRows {
  const ordered = orderNavigationTargets(mode, targets);
  const qualifiers: NavigationQualifiers = {
    repositories: repositoryQualifiers(ordered),
    workspaces: workspaceQualifiers(ordered),
  };
  const items = ordered.map((target): PickerItem => {
    const group = mode === "projects" ? undefined : navigationGroup(target, qualifiers.repositories);
    const identity = navigationIdentity(mode, target, qualifiers);
    const detail = target.detail ? sanitize(target.detail) : undefined;
    const badge = mode === "all" ? target.kind : undefined;
    const marker = target.current ? currentMarker() : "";
    return {
      id: target.id,
      target: target.id,
      group,
      searchText: [group?.label, badge, identity, detail].filter(Boolean).join(SEARCH_FIELD_SEPARATOR),
      display: renderNavigationTarget(mode, target, identity, detail, false, marker),
      selectedDisplay: renderNavigationTarget(mode, target, identity, detail, true, marker),
    };
  });
  return { items, focusedId: ordered.find((target) => target.current)?.id };
}

function renderGroup(label: string, unknown: boolean): string {
  const base = trueColor(unknown ? PICKER_PALETTE.muted : PICKER_PALETTE.group, GROUP_PREFIX + label);
  return unknown ? dim(base) : bold(base);
}

function renderTargetLine(target: AgentTarget, state: AgentState, selected: boolean): string {
  const glyph = trueColor(statusColor(state), statusGlyph(state));
  const worktree = target.worktree ? sanitize(target.worktree) : undefined;
  const label = sanitize(target.agentLabel);
  const relation = worktree ? worktree + RELATION_SEPARATOR : "";
  const identity = selected
    ? bold(trueColor(statusColor(state), relation + label))
    : `${worktree ? trueColor(PICKER_PALETTE.muted, relation) : ""}${trueColor(PICKER_PALETTE.identity, label)}`;
  // Children nest under their repository header so the list reads as a tree:
  // the header owns the first column, agent rows indent beneath it.
  return `  ${glyph} ${identity}`;
}

function navigationGroup(
  target: PickerTarget,
  qualifiers: ReadonlyMap<string, string>,
): PickerGroup {
  const label = repoLabel(target, qualifiers);
  const unknown = target.repo === undefined;
  return {
    key: repositoryKey(target),
    label,
    display: renderGroup(label, unknown),
  };
}

function currentMarker(): string {
  return trueColor(PICKER_PALETTE.current, CURRENT_MARKER) + CURRENT_MARKER_SUFFIX;
}

function renderNavigationTarget(
  mode: NavigationMode,
  target: PickerTarget,
  identity: string,
  detail: string | undefined,
  selected: boolean,
  marker = "",
): string {
  const kindColor = PICKER_PALETTE.kind[target.kind];
  const badge = mode === "all" ? `${trueColor(kindColor, `[${target.kind}]`)} ` : "";
  const primaryColor = selected
    ? PICKER_PALETTE.selected
    : mode === "all"
      ? kindColor
      : PICKER_PALETTE.muted;
  const primary = bold(trueColor(primaryColor, identity));
  return `  ${marker}${badge}${primary}${detail ? ` ${trueColor(PICKER_PALETTE.muted, detail)}` : ""}`;
}

function navigationIdentity(
  mode: NavigationMode,
  target: PickerTarget,
  qualifiers: NavigationQualifiers,
): string {
  const label = navigationDisplayLabel(target);
  const qualifier = mode === "projects"
    ? qualifiers.repositories.get(repositoryKey(target))
    : qualifiers.workspaces.get(target.id);
  return sanitize(qualifier ? `${label}${GROUP_QUALIFIER_SEPARATOR}${qualifier}` : label);
}

function repoLabel(target: RepositoryTarget, qualifiers: ReadonlyMap<string, string>): string {
  const label = target.repo ?? UNKNOWN_REPO;
  const qualifier = qualifiers.get(target.repoKey ?? UNKNOWN_REPO_KEY);
  return sanitize(qualifier ? `${label}${GROUP_QUALIFIER_SEPARATOR}${qualifier}` : label);
}

// Duplicate repository names gain the shortest unique parent path suffix so
// grouped headers never read as the same repository twice.
function repositoryQualifiers(targets: readonly RepositoryTarget[]): ReadonlyMap<string, string> {
  const keysByLabel = new Map<string, Set<string>>();
  for (const target of targets) {
    const label = target.repo ?? UNKNOWN_REPO;
    const keys = keysByLabel.get(label) ?? new Set<string>();
    keys.add(target.repoKey ?? UNKNOWN_REPO_KEY);
    keysByLabel.set(label, keys);
  }

  const result = new Map<string, string>();
  for (const [label, keys] of keysByLabel) {
    if (keys.size < 2) continue;
    const partsByKey = new Map([...keys].map((key) => [key, repositoryParentParts(key, label)]));
    shortestUniqueSuffixes(partsByKey).forEach((qualifier, key) => result.set(key, qualifier));
  }
  return result;
}

function repositoryParentParts(key: string, label: string): string[] {
  if (key === UNKNOWN_REPO_KEY) return ["untracked"];
  const parent = dirname(key);
  if (parent === ".") return [key === label ? "." : `@${key}`];
  return pathParts(parent);
}

function pathParts(path: string): string[] {
  const root = parse(path).root;
  const parts = path.slice(root.length).split(sep).filter(Boolean);
  return parts.length > 0 ? parts : [root || path];
}

function shortestUniqueSuffixes(partsByKey: ReadonlyMap<string, readonly string[]>): ReadonlyMap<string, string> {
  const depths = new Map([...partsByKey.keys()].map((key) => [key, 1]));
  while (true) {
    const candidates = new Map([...partsByKey].map(([key, parts]) => [key, parts.slice(-(depths.get(key) ?? 1)).join("/")]));
    const keysByCandidate = new Map<string, string[]>();
    candidates.forEach((candidate, key) => {
      keysByCandidate.set(candidate, [...(keysByCandidate.get(candidate) ?? []), key]);
    });
    const collisions = [...keysByCandidate.values()].filter((keys) => keys.length > 1);
    if (collisions.length === 0) return candidates;

    let advanced = false;
    for (const keys of collisions) {
      for (const key of keys) {
        const depth = depths.get(key) ?? 1;
        if (depth >= (partsByKey.get(key)?.length ?? 0)) continue;
        depths.set(key, depth + 1);
        advanced = true;
      }
    }
    if (!advanced) return new Map();
  }
}

// Agents order by repository (label then stable key), then agent identity, then
// the rendered relation, then target id for total determinism.
function orderAgents(targets: readonly AgentTarget[]): AgentTarget[] {
  return targets.toSorted((left, right) => {
    const byRepo = compareRepositories(left, right);
    if (byRepo !== 0) return byRepo;
    const byAgent = left.agentLabel.localeCompare(right.agentLabel);
    if (byAgent !== 0) return byAgent;
    const byLabel = agentDisplayLabel(left).localeCompare(agentDisplayLabel(right));
    return byLabel !== 0 ? byLabel : left.id.localeCompare(right.id);
  });
}

function orderNavigationTargets(mode: NavigationMode, targets: readonly PickerTarget[]): PickerTarget[] {
  return targets.toSorted((left, right) => {
    if (mode !== "projects") {
      const byRepo = compareRepositories(left, right);
      if (byRepo !== 0) return byRepo;
    }
    if (mode === "all") {
      const byKind = KIND_PRIORITY[left.kind] - KIND_PRIORITY[right.kind];
      if (byKind !== 0) return byKind;
    }
    const byLabel = navigationDisplayLabel(left).localeCompare(navigationDisplayLabel(right));
    return byLabel !== 0 ? byLabel : left.id.localeCompare(right.id);
  });
}

function workspaceQualifiers(targets: readonly PickerTarget[]): ReadonlyMap<string, string> {
  const groups = new Map<string, Extract<PickerTarget, { readonly kind: "workspace" }>[]>();
  for (const target of targets) {
    if (target.kind !== "workspace") continue;
    const signature = [repositoryKey(target), navigationDisplayLabel(target), sanitize(target.detail ?? "")].join("\0");
    const group = groups.get(signature) ?? [];
    group.push(target);
    groups.set(signature, group);
  }

  const result = new Map<string, string>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const partsById = new Map<string, string[]>();
    for (const target of group) {
      const path = target.path ?? target.cwd;
      if (path) partsById.set(target.id, pathParts(path));
    }
    if (partsById.size !== group.length) continue;
    shortestUniqueSuffixes(partsById).forEach((qualifier, id) => result.set(id, qualifier));
  }
  return result;
}

function agentDisplayLabel(target: AgentTarget): string {
  return sanitize(target.boardLabel ?? target.label);
}

function navigationDisplayLabel(target: PickerTarget): string {
  return sanitize(target.boardLabel ?? target.label);
}

function repositoryKey(target: RepositoryTarget): string {
  return target.repoKey ?? UNKNOWN_REPO_KEY;
}

function compareRepositories(left: RepositoryTarget, right: RepositoryTarget): number {
  const byLabel = (left.repo ?? UNKNOWN_REPO).localeCompare(right.repo ?? UNKNOWN_REPO);
  return byLabel !== 0 ? byLabel : (left.repoKey ?? UNKNOWN_REPO_KEY).localeCompare(right.repoKey ?? UNKNOWN_REPO_KEY);
}

// Strip ANSI sequences, bidi controls, and control codes from metadata
// rendered into rows so hidden escapes and tabs can never leak into the
// visible fields.
function sanitize(value: string): string {
  return sanitizeTerminalText(value);
}
