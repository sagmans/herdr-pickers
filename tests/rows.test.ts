import { describe, expect, test } from "bun:test";

import type { AgentTarget, PickerTarget } from "../src/catalog.ts";
import { rankRows } from "../src/fzf.ts";
import { renderAgentRows, renderNavigationRows } from "../src/rows.ts";

const RESET = "\x1b[0m";
const TOKYO_NIGHT = {
  group: "\x1b[38;2;217;139;182m",
  selected: "\x1b[38;2;139;217;174m",
  identity: "\x1b[38;2;216;216;216m",
  muted: "\x1b[38;2;115;122;162m",
  blocked: "\x1b[38;2;247;118;142m",
  working: "\x1b[38;2;224;175;104m",
  done: "\x1b[38;2;125;207;255m",
  idle: "\x1b[38;2;158;206;106m",
  project: "\x1b[38;2;158;206;106m",
  workspace: "\x1b[38;2;122;162;247m",
  worktree: "\x1b[38;2;255;158;100m",
} as const;

function agent(partial: Partial<AgentTarget> & { readonly id: string; readonly agentTarget: string; readonly agentLabel: string }): AgentTarget {
  return {
    kind: "agent",
    focused: false,
    boardLabel: partial.agentLabel,
    label: partial.agentLabel,
    repoKey: partial.repo === undefined ? undefined : partial.repoKey ?? `/repo/${partial.repo}`,
    ...partial,
  };
}

describe("agent row rendering", () => {
  test("orders by repository, agent label, then relation", () => {
    const { items } = renderAgentRows([
      agent({ id: "b", agentTarget: "b", agentLabel: "zed", repo: "beta" }),
      agent({ id: "a2", agentTarget: "a2", agentLabel: "alpha", repo: "alpha", worktree: "main", status: "working" }),
      agent({ id: "a1", agentTarget: "a1", agentLabel: "alpha", repo: "alpha", worktree: "main", status: "idle" }),
    ]);

    expect(items).toHaveLength(3);
    expect(items[0]?.group?.display).toBe(`\x1b[1m${TOKYO_NIGHT.group}▾ alpha${RESET}${RESET}`);
    expect(items.map((item) => item.target)).toEqual(["a1", "a2", "b"]);
    expect(items[2]?.group?.display).toBe(`\x1b[1m${TOKYO_NIGHT.group}▾ beta${RESET}${RESET}`);
    expect(items[0]?.display.startsWith("  \x1b[")).toBe(true);
  });

  test("keeps relation muted and agent label neutral", () => {
    const { items } = renderAgentRows([
      agent({ id: "a1", agentTarget: "pane-1", agentLabel: "pi", repo: "sample-repo", worktree: "main", status: "blocked" }),
    ]);

    expect(items[0]?.group?.display).toBe(`\x1b[1m${TOKYO_NIGHT.group}▾ sample-repo${RESET}${RESET}`);
    expect(items[0]?.display).toBe(`  ${TOKYO_NIGHT.blocked}●${RESET} ${TOKYO_NIGHT.muted}main ▸ ${RESET}${TOKYO_NIGHT.identity}pi${RESET}`);
    expect(items[0]?.selectedDisplay).toBe(`  ${TOKYO_NIGHT.blocked}●${RESET} \x1b[1m${TOKYO_NIGHT.blocked}main ▸ pi${RESET}${RESET}`);
    expect(items[0]?.selectionColor).toEqual({ red: 247, green: 118, blue: 142 });
  });

  test("falls back to the agent label alone when no workspace relation exists", () => {
    const { items } = renderAgentRows([
      agent({ id: "a1", agentTarget: "pane-1", agentLabel: "Codex" }),
    ]);

    expect(items[0]?.display).toBe(`  ${TOKYO_NIGHT.muted}·${RESET} ${TOKYO_NIGHT.identity}Codex${RESET}`);
  });

  test("marks unknown repositories with a dim gray header", () => {
    const { items } = renderAgentRows([
      agent({ id: "a1", agentTarget: "pane-1", agentLabel: "pi", cwd: "/somewhere" }),
    ]);

    expect(items[0]?.group?.display).toBe(`\x1b[2m${TOKYO_NIGHT.muted}▾ unknown repo${RESET}${RESET}`);
  });

  test("qualifies duplicate repository names with the shortest unique parent", () => {
    const { items } = renderAgentRows([
      agent({ id: "a1", agentTarget: "pane-1", agentLabel: "pi", repo: "sample-repo", repoKey: "/home/dev/sample-repo" }),
      agent({ id: "a2", agentTarget: "pane-2", agentLabel: "pi", repo: "sample-repo", repoKey: "/home/alice/sample-repo" }),
    ]);

    expect(items[0]?.group?.display).toBe(`\x1b[1m${TOKYO_NIGHT.group}▾ sample-repo · alice${RESET}${RESET}`);
    expect(items[1]?.group?.display).toBe(`\x1b[1m${TOKYO_NIGHT.group}▾ sample-repo · dev${RESET}${RESET}`);
  });

  test("marks the focused agent line for picker preselection", () => {
    const { focusedId } = renderAgentRows([
      agent({ id: "a1", agentTarget: "pane-1", agentLabel: "alpha", repo: "alpha" }),
      agent({ id: "a2", agentTarget: "pane-2", agentLabel: "pi", repo: "beta", focused: true }),
    ]);

    expect(focusedId).toBe("a2");
  });

  test("reports no focused line when no agent is focused", () => {
    const { focusedId } = renderAgentRows([
      agent({ id: "a1", agentTarget: "pane-1", agentLabel: "alpha" }),
    ]);

    expect(focusedId).toBeUndefined();
  });

  test("sanitizes control characters and escape sequences out of labels", () => {
    const { items } = renderAgentRows([
      agent({ id: "a1", agentTarget: "pane-1", agentLabel: "pi\x1b[31mred\x1b[0m", worktree: "main\tjunk" }),
    ]);

    expect(items[0]?.display).toBe(`  ${TOKYO_NIGHT.muted}·${RESET} ${TOKYO_NIGHT.muted}main junk ▸ ${RESET}${TOKYO_NIGHT.identity}pired${RESET}`);
  });

  test("treats repository and agent text as one searchable entity", async () => {
    const { items } = renderAgentRows([
      agent({ id: "a1", agentTarget: "pane-1", agentLabel: "pi", repo: "bum", worktree: "main" }),
      agent({ id: "a2", agentTarget: "pane-2", agentLabel: "codex", repo: "bum", worktree: "feature" }),
    ]);

    const ranked = await rankRows("bum", items);

    expect(ranked.map((item) => item.target).sort()).toEqual(["pane-1", "pane-2"]);
  });

  test("mirrors Herdr's static dot status indicators", () => {
    const displays = (["blocked", "working", "done", "idle", "unknown"] as const).map((status) => {
      const { items } = renderAgentRows([
        agent({ id: status, agentTarget: status, agentLabel: "pi", repo: "sample-repo", status }),
      ]);
      return items[0]?.display;
    });

    expect(displays).toEqual([
      `  ${TOKYO_NIGHT.blocked}●${RESET} ${TOKYO_NIGHT.identity}pi${RESET}`,
      `  ${TOKYO_NIGHT.working}●${RESET} ${TOKYO_NIGHT.identity}pi${RESET}`,
      `  ${TOKYO_NIGHT.done}●${RESET} ${TOKYO_NIGHT.identity}pi${RESET}`,
      `  ${TOKYO_NIGHT.idle}○${RESET} ${TOKYO_NIGHT.identity}pi${RESET}`,
      `  ${TOKYO_NIGHT.muted}·${RESET} ${TOKYO_NIGHT.identity}pi${RESET}`,
    ]);
  });
});

describe("navigation row rendering", () => {
  function project(path: string, repo: string): PickerTarget {
    return { kind: "project", id: `project:${path}`, path, current: false, repo, repoKey: path, boardLabel: repo, label: repo };
  }

  function workspace(id: string, repo: string, name: string): Extract<PickerTarget, { readonly kind: "workspace" }> {
    return {
      kind: "workspace",
      id: `workspace:${id}`,
      workspaceId: id,
      current: false,
      repo,
      repoKey: `/repo/${repo}`,
      boardLabel: name,
      label: `${repo} ▸ ${name}`,
    };
  }

  function worktree(path: string, repo: string, name: string): PickerTarget {
    return {
      kind: "worktree",
      id: `worktree:${path}`,
      path,
      current: false,
      repoRoot: `/repo/${repo}`,
      repo,
      repoKey: `/repo/${repo}`,
      boardLabel: name,
      label: `${repo} ▸ ${name}`,
    };
  }

  test("all mode groups by repository and orders target kinds", () => {
    const { items } = renderNavigationRows("all", [
      worktree("/repo/alpha/wt", "alpha", "wt"),
      workspace("w1", "alpha", "main"),
      project("/repo/alpha", "alpha"),
    ]);

    expect(items.map((item) => [item.group?.label, item.target])).toEqual([
      ["alpha", "project:/repo/alpha"],
      ["alpha", "workspace:w1"],
      ["alpha", "worktree:/repo/alpha/wt"],
    ]);
    expect(items.map((item) => item.display)).toEqual([
      `  ${TOKYO_NIGHT.project}[project]${RESET} \x1b[1m${TOKYO_NIGHT.project}alpha${RESET}${RESET}`,
      `  ${TOKYO_NIGHT.workspace}[workspace]${RESET} \x1b[1m${TOKYO_NIGHT.workspace}main${RESET}${RESET}`,
      `  ${TOKYO_NIGHT.worktree}[worktree]${RESET} \x1b[1m${TOKYO_NIGHT.worktree}wt${RESET}${RESET}`,
    ]);
    expect(items.map((item) => item.selectedDisplay)).toEqual([
      `  ${TOKYO_NIGHT.project}[project]${RESET} \x1b[1m${TOKYO_NIGHT.selected}alpha${RESET}${RESET}`,
      `  ${TOKYO_NIGHT.workspace}[workspace]${RESET} \x1b[1m${TOKYO_NIGHT.selected}main${RESET}${RESET}`,
      `  ${TOKYO_NIGHT.worktree}[worktree]${RESET} \x1b[1m${TOKYO_NIGHT.selected}wt${RESET}${RESET}`,
    ]);
  });

  test("uses one muted identity color across dedicated navigation modes", () => {
    const items = [
      renderNavigationRows("projects", [project("/repo/alpha", "alpha")]).items[0],
      renderNavigationRows("workspaces", [workspace("w1", "alpha", "main")]).items[0],
      renderNavigationRows("worktrees", [worktree("/repo/alpha/wt", "alpha", "wt")]).items[0],
      renderNavigationRows("repo-workspaces", [workspace("w2", "alpha", "repo")]).items[0],
      renderNavigationRows("repo-worktrees", [worktree("/repo/alpha/repo-wt", "alpha", "repo-wt")]).items[0],
    ];

    expect(items.map((item) => item?.display)).toEqual([
      `  \x1b[1m${TOKYO_NIGHT.muted}alpha${RESET}${RESET}`,
      `  \x1b[1m${TOKYO_NIGHT.muted}main${RESET}${RESET}`,
      `  \x1b[1m${TOKYO_NIGHT.muted}wt${RESET}${RESET}`,
      `  \x1b[1m${TOKYO_NIGHT.muted}repo${RESET}${RESET}`,
      `  \x1b[1m${TOKYO_NIGHT.muted}repo-wt${RESET}${RESET}`,
    ]);
  });

  test("projects stay flat and duplicate names gain shortest unique qualifiers", () => {
    const { items } = renderNavigationRows("projects", [
      project("/org-a/team/shared", "shared"),
      project("/org-b/team/shared", "shared"),
    ]);

    expect(items.map((item) => item.group)).toEqual([undefined, undefined]);
    expect(items.map((item) => item.searchText)).toEqual([
      "shared · org-a/team",
      "shared · org-b/team",
    ]);
  });

  test("duplicate repository names gain distinct group qualifiers", () => {
    const { items } = renderNavigationRows("workspaces", [
      { ...workspace("a", "shared", "main"), repoKey: "/owner-a/shared" },
      { ...workspace("b", "shared", "main"), repoKey: "/owner-b/shared" },
    ]);

    expect(items.map((item) => item.group?.label)).toEqual(["shared · owner-a", "shared · owner-b"]);
    expect(new Set(items.map((item) => item.group?.key)).size).toBe(2);
  });

  test("duplicate workspace identities gain shortest visible path suffixes", () => {
    const { items } = renderNavigationRows("workspaces", [
      { ...workspace("w1", "shared", "preview"), path: "/repos/shared/wt-one" },
      { ...workspace("w2", "shared", "preview"), path: "/repos/shared/wt-two" },
    ]);

    expect(items.map((item) => item.searchText)).toEqual([
      "shared preview · wt-one",
      "shared preview · wt-two",
    ]);
    expect(items.map((item) => item.display).join("\n")).not.toContain("/repos/shared");
  });

  test("search corpus contains only visible group, identity, and detail text", () => {
    const { items } = renderNavigationRows("workspaces", [{
      ...workspace("secret-id", "shared", "preview"),
      path: "/private/hidden/worktree",
      cwd: "/private/hidden/cwd",
      detail: "feature branch",
      agentStatus: "agent idle",
    }]);

    expect(items[0]?.searchText).toBe("shared preview feature branch");
    expect(items[0]?.searchText).not.toContain("secret-id");
    expect(items[0]?.searchText).not.toContain("private");
    expect(items[0]?.searchText).not.toContain("idle");
  });

  test("preselects and marks the current navigation target", () => {
    const { items, focusedId } = renderNavigationRows("workspaces", [
      workspace("w2", "alpha", "other"),
      { ...workspace("w1", "alpha", "main"), current: true },
    ]);

    expect(focusedId).toBe("workspace:w1");
    const current = items.find((item) => item.id === "workspace:w1");
    expect(current?.display).toBe(`  ${TOKYO_NIGHT.selected}●${RESET} \x1b[1m${TOKYO_NIGHT.muted}main${RESET}${RESET}`);
    expect(current?.selectedDisplay).toBe(`  ${TOKYO_NIGHT.selected}●${RESET} \x1b[1m${TOKYO_NIGHT.selected}main${RESET}${RESET}`);
    expect(items.find((item) => item.id === "workspace:w2")?.display).not.toContain("●");
  });

  test("sanitizes ANSI and controls before display and search", () => {
    const { items } = renderNavigationRows("workspaces", [{
      ...workspace("w1", "sample-repo\x1b[31m", "feature\nname"),
      detail: "feat\tbranch",
    }]);

    expect(items[0]?.group?.label).toBe("sample-repo");
    expect(items[0]?.searchText).toBe("sample-repo feature name feat branch");
    expect(items[0]?.searchText).not.toContain("\x1b");
  });
});

function controlHygieneWorkspace(id: string, repo: string, name: string): PickerTarget {
  return {
    kind: "workspace",
    id: "workspace:" + id,
    workspaceId: id,
    current: false,
    repo,
    repoKey: "/repo/" + repo,
    boardLabel: name,
    label: repo + " \u25B8 " + name,
  };
}

describe("terminal control hygiene in labels", () => {
  test("strips OSC and bidi controls from workspace navigation labels", () => {
    const { items } = renderNavigationRows("workspaces", [
      controlHygieneWorkspace("w1", "re\u001B]0;evil\u0007po", "bra\u2066nch"),
      controlHygieneWorkspace("w2", "\u202Eclean", "main"),
    ]);
    // Labels and search text are the sanitized surfaces; display rows
    // intentionally carry styling sequences.
    const corpus = items.map((item) => [item.group?.label, item.searchText].join(" ")).join(" ");
    expect(corpus).not.toContain("\u001B");
    expect(corpus).not.toContain("\u2066");
    expect(corpus).not.toContain("\u202E");
    expect(corpus).toContain("repo");
  });

  test("strips OSC and bidi controls from agent rows", () => {
    const { items } = renderAgentRows([
      agent({ id: "a1", agentTarget: "pane-1", agentLabel: "p\u001B]0;x\u0007i", repo: "r\u2066epo", worktree: "ma\u202Ein" }),
    ]);
    const corpus = items.map((item) => [item.group?.label, item.searchText].join(" ")).join(" ");
    expect(corpus).not.toContain("\u001B");
    expect(corpus).not.toContain("\u2066");
    expect(corpus).not.toContain("\u202E");
  });
});

