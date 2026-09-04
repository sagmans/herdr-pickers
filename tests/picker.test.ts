import { describe, expect, test } from "bun:test";

import { buildPaneOpenArgs } from "../src/actions/open.ts";
import { Herdr, type CommandRunner } from "../src/client/herdr.ts";
import { parseConfig } from "../src/config/config.ts";
import { AgentTargetError, loadAgentTargets, parseMode, runAgentPicker, runPicker, type PickerRunner } from "../src/picker.ts";
import type { TerminalPickerOptions } from "../src/terminal-picker.ts";

type PickerCall = TerminalPickerOptions;

function fakePicker(target: string | undefined): { readonly runner: PickerRunner; readonly calls: PickerCall[] } {
  const calls: PickerCall[] = [];
  const runner: PickerRunner = async (options) => {
    calls.push(options);
    return target === undefined ? undefined : options.items.find((item) => item.target === target);
  };
  return { runner, calls };
}

function herdrWith(routes: Record<string, () => { stdout: string; stderr: string; exitCode: number }>, commands: string[][] = []): Herdr {
  const runner: CommandRunner = async (argv) => {
    const joined = argv.join(" ");
    commands.push([...argv.slice(1)]);
    const route = Object.entries(routes).find(([key]) => joined.includes(key))?.[1];
    return route ? route() : { stdout: '{"result":{}}', stderr: "", exitCode: 0 };
  };
  return new Herdr({ runner });
}

const AGENTS = '{"result":{"agents":[{"terminal_id":"t1","label":"pi","workspace_id":"w1","focused":true},{"terminal_id":"t2","label":"alpha","workspace_id":"w1","status":"working"}]}}';
const WORKSPACES = '{"result":{"workspaces":[{"workspace_id":"w1","focused":true,"worktree":{"repo_root":"/repo/sample-repo","repo_name":"sample-repo","checkout_path":"/repo/sample-repo/main","is_linked_worktree":true}}]}}';
const NO_AGENTS_MESSAGE = "No agents found.";
const CONFIG_PATH = "/example/config.toml";
const KEYMAP_CONFIG = parseConfig('[keymap]\ndown = ["ctrl-j"]\n', CONFIG_PATH);

describe("modes", () => {
  test("parses all eight picker modes and rejects unknown modes", () => {
    for (const mode of [
      "all",
      "projects",
      "workspaces",
      "repo-workspaces",
      "worktrees",
      "repo-worktrees",
      "agents",
      "repo-agents",
    ] as const) {
      expect(parseMode(mode)).toBe(mode);
    }
    expect(() => parseMode("bad")).toThrow(/Valid modes/);
  });

  test("builds plugin pane open args with mode and source context", () => {
    expect(buildPaneOpenArgs({ pluginId: "herdr-pickers", mode: "agents" })).toEqual([
      "plugin",
      "pane",
      "open",
      "--plugin",
      "herdr-pickers",
      "--entrypoint",
      "picker",
      "--env",
      "HERDR_PICKERS_MODE=agents",
    ]);
    expect(buildPaneOpenArgs({
      pluginId: "herdr-pickers",
      mode: "repo-agents",
      env: { HERDR_WORKSPACE_ID: "w7", HERDR_TAB_ID: "w7:t1", HERDR_PANE_ID: "w7:p1", PWD: "/repo/sample-repo" },
    })).toContain("HERDR_PICKERS_SOURCE_PANE_ID=w7:p1");
    expect(buildPaneOpenArgs({ pluginId: "herdr-pickers", mode: "repo-workspaces" })).toContain("HERDR_PICKERS_MODE=repo-workspaces");
  });

  test("omits placement flags for popup", () => {
    expect(buildPaneOpenArgs({ pluginId: "herdr-pickers", mode: "agents", placement: "popup" })).toEqual([
      "plugin",
      "pane",
      "open",
      "--plugin",
      "herdr-pickers",
      "--entrypoint",
      "picker",
      "--env",
      "HERDR_PICKERS_MODE=agents",
    ]);
  });

  test("adds overlay placement after the picker entrypoint", () => {
    const args = buildPaneOpenArgs({
      pluginId: "herdr-pickers",
      mode: "agents",
      placement: "overlay",
      env: { HERDR_WORKSPACE_ID: "w7", HERDR_TAB_ID: "w7:t1", HERDR_PANE_ID: "w7:p1", PWD: "/repo/sample-repo" },
    });

    expect(args.slice(0, 9)).toEqual([
      "plugin",
      "pane",
      "open",
      "--plugin",
      "herdr-pickers",
      "--entrypoint",
      "picker",
      "--placement",
      "overlay",
    ]);
    expect(args).toContain("HERDR_PICKERS_MODE=agents");
    expect(args).toContain("HERDR_PICKERS_SOURCE_PANE_ID=w7:p1");
  });
});

describe("picker flow", () => {
  test("dispatches the accepted agent selection", async () => {
    const commands: string[][] = [];
    const herdr = herdrWith({
      "workspace list": () => ({ stdout: WORKSPACES, stderr: "", exitCode: 0 }),
      "agent list": () => ({ stdout: AGENTS, stderr: "", exitCode: 0 }),
    }, commands);
    const picker = fakePicker("t2");

    const outcome = await runAgentPicker("agents", { herdr, env: {}, pickerRunner: picker.runner, config: KEYMAP_CONFIG });

    expect(outcome).toBe("dispatched");
    expect(commands).toContainEqual(["agent", "focus", "t2"]);
    expect(picker.calls[0]?.keymap).toBe(KEYMAP_CONFIG.keymap);
    expect(picker.calls[0]?.items[0]?.group?.display).toContain("▾ sample-repo");
    expect(picker.calls[0]?.prompt).toBe("agents › ");
  });

  test("supplies group headers only as non-selectable agent context", async () => {
    const commands: string[][] = [];
    const herdr = herdrWith({
      "workspace list": () => ({ stdout: WORKSPACES, stderr: "", exitCode: 0 }),
      "agent list": () => ({ stdout: AGENTS, stderr: "", exitCode: 0 }),
    }, commands);
    const picker = fakePicker(undefined);

    const outcome = await runAgentPicker("agents", { herdr, env: {}, pickerRunner: picker.runner });

    expect(outcome).toBe("cancelled");
    expect(picker.calls[0]?.items.map((item) => item.target)).toEqual(["t2", "t1"]);
    expect(picker.calls[0]?.items.every((item) => item.group?.label === "sample-repo")).toBe(true);
    expect(commands.flat().join(" ")).not.toContain("agent focus");
  });

  test("treats picker cancellation as a clean close", async () => {
    const commands: string[][] = [];
    const herdr = herdrWith({
      "workspace list": () => ({ stdout: WORKSPACES, stderr: "", exitCode: 0 }),
      "agent list": () => ({ stdout: AGENTS, stderr: "", exitCode: 0 }),
    }, commands);
    const picker = fakePicker(undefined);

    const outcome = await runAgentPicker("agents", { herdr, env: {}, pickerRunner: picker.runner });

    expect(outcome).toBe("cancelled");
    expect(commands.flat().join(" ")).not.toContain("agent focus");
  });

  test("reports no-agents without launching the picker", async () => {
    const picker = fakePicker(undefined);
    const herdr = herdrWith({
      "workspace list": () => ({ stdout: '{"result":{"workspaces":[]}}', stderr: "", exitCode: 0 }),
      "agent list": () => ({ stdout: '{"result":{"agents":[]}}', stderr: "", exitCode: 0 }),
    });

    const outcome = await runAgentPicker("agents", { herdr, env: {}, pickerRunner: picker.runner });

    expect(outcome).toBe("no-agents");
    expect(picker.calls).toHaveLength(0);
  });

  test("supplies a direct Herdr row reload to the picker", async () => {
    let agentReads = 0;
    const herdr = herdrWith({
      "workspace list": () => ({ stdout: WORKSPACES, stderr: "", exitCode: 0 }),
      "agent list": () => {
        agentReads += 1;
        return { stdout: AGENTS, stderr: "", exitCode: 0 };
      },
    });
    const runner: PickerRunner = async (options) => {
      expect(options.noun).toBe("agents");
      expect(options.live).toBe(true);
      expect(options.emptyMessage).toBe(NO_AGENTS_MESSAGE);
      expect(options.refreshIntervalMilliseconds).toBe(1000);
      expect(options.loadOnStart).toBeUndefined();
      const refreshed = await options.reload?.();
      expect(refreshed?.items[0]?.group?.display).toContain("▾ sample-repo");
      return undefined;
    };

    await runAgentPicker("agents", { herdr, env: {}, pickerRunner: runner });

    expect(agentReads).toBe(2);
  });

  test("reports agents without stable targets as an error", async () => {
    const herdr = herdrWith({
      "workspace list": () => ({ stdout: '{"result":{"workspaces":[]}}', stderr: "", exitCode: 0 }),
      "agent list": () => ({ stdout: '{"result":{"agents":[{"id":"internal","agent":"Claude"}]}}', stderr: "", exitCode: 0 }),
    });

    await expect(loadAgentTargets("agents", herdr, {})).rejects.toThrow(AgentTargetError);
  });
});

describe("navigation picker flow", () => {
  test("dispatches selected typed navigation targets", async () => {
    const commands: string[][] = [];
    const herdr = herdrWith({
      "workspace list": () => ({
        stdout: '{"result":{"workspaces":[{"workspace_id":"w1","focused":true},{"workspace_id":"w2","label":"other"}]}}',
        stderr: "",
        exitCode: 0,
      }),
    }, commands);
    const runner: PickerRunner = async (options) => {
      expect(options.items).toEqual([]);
      expect(options.loadOnStart).toBe(true);
      expect(options.refreshIntervalMilliseconds).toBeUndefined();
      expect(options.keymap).toBe(KEYMAP_CONFIG.keymap);
      expect(commands).toEqual([]);
      const loaded = await options.reload?.();
      expect(loaded?.focusedId).toBe("workspace:w1");
      expect(loaded?.items.length).toBeGreaterThan(0);
      return loaded?.items.find((item) => item.target === "workspace:w2");
    };

    const outcome = await runPicker("workspaces", { herdr, env: {}, pickerRunner: runner, config: KEYMAP_CONFIG });

    expect(outcome).toBe("dispatched");
    expect(commands).toContainEqual(["workspace", "focus", "w2"]);
  });

  test("keeps empty navigation catalogs open and reloadable", async () => {
    const herdr = herdrWith({
      "workspace list": () => ({ stdout: '{"result":{"workspaces":[]}}', stderr: "", exitCode: 0 }),
    });
    let reloads = 0;
    const runner: PickerRunner = async (options) => {
      expect(options.items).toEqual([]);
      expect(options.emptyMessage).toBe("No workspaces found.");
      await options.reload?.();
      reloads += 1;
      return undefined;
    };

    const outcome = await runPicker("workspaces", { herdr, env: {}, pickerRunner: runner });

    expect(outcome).toBe("cancelled");
    expect(reloads).toBe(1);
  });

  test("resolves selections against targets from the latest reload", async () => {
    let reads = 0;
    const commands: string[][] = [];
    const herdr = herdrWith({
      "workspace list": () => {
        reads += 1;
        const targetId = reads === 1 ? "w2" : "w3";
        return {
          stdout: JSON.stringify({ result: { workspaces: [
            { workspace_id: "w1", focused: true },
            { workspace_id: targetId, label: targetId },
          ] } }),
          stderr: "",
          exitCode: 0,
        };
      },
    }, commands);
    const runner: PickerRunner = async (options) => {
      await options.reload?.();
      const refreshed = await options.reload?.();
      return refreshed?.items.find((item) => item.target === "workspace:w3");
    };

    const outcome = await runPicker("workspaces", { herdr, env: {}, pickerRunner: runner });

    expect(outcome).toBe("dispatched");
    expect(commands).toContainEqual(["workspace", "focus", "w3"]);
  });

  test("routes agent modes through existing no-popup semantics", async () => {
    const picker = fakePicker(undefined);
    const herdr = herdrWith({
      "workspace list": () => ({ stdout: '{"result":{"workspaces":[]}}', stderr: "", exitCode: 0 }),
      "agent list": () => ({ stdout: '{"result":{"agents":[]}}', stderr: "", exitCode: 0 }),
    });

    const outcome = await runPicker("agents", { herdr, env: {}, pickerRunner: picker.runner });

    expect(outcome).toBe("no-agents");
    expect(picker.calls).toEqual([]);
  });
});

describe("repository agent scoping", () => {
  test("filters by source workspace repository", async () => {
    const herdr = herdrWith({
      "workspace list": () => ({ stdout: WORKSPACES, stderr: "", exitCode: 0 }),
      "agent list": () => ({ stdout: AGENTS, stderr: "", exitCode: 0 }),
    });

    const targets = await loadAgentTargets("repo-agents", herdr, { HERDR_PICKERS_SOURCE_WORKSPACE_ID: "w1" });

    expect(targets.map((target) => target.agentTarget).sort()).toEqual(["t1", "t2"]);
  });

  test("falls back to the worktree list source when provenance is missing", async () => {
    const commands: string[][] = [];
    const fallbackAgents = '{"result":{"agents":[{"terminal_id":"t1","label":"pi","cwd":"/repo/sample-repo","focused":true}]}}';
    const herdr = herdrWith({
      "workspace list": () => ({ stdout: '{"result":{"workspaces":[{"workspace_id":"w1","focused":true}]}}', stderr: "", exitCode: 0 }),
      "agent list": () => ({ stdout: fallbackAgents, stderr: "", exitCode: 0 }),
      "worktree list": () => ({ stdout: '{"result":{"source":{"repo_root":"/repo/sample-repo"},"worktrees":[]}}', stderr: "", exitCode: 0 }),
    }, commands);

    const targets = await loadAgentTargets("repo-agents", herdr, { HERDR_PICKERS_SOURCE_WORKSPACE_ID: "w1" });

    // Without workspace provenance, the scope comes from the worktree list,
    // and agents without their own cwd in the repository stay excluded.
    expect(targets.map((target) => target.agentTarget)).toEqual(["t1"]);
    expect(commands.some((command) => command.join(" ").includes("worktree list --workspace w1"))).toBe(true);
  });

  test("excludes agents from other repositories", async () => {
    const other = '{"result":{"agents":[{"terminal_id":"t3","label":"pi","workspace_id":"w2","focused":true}]}}';
    const herdr = herdrWith({
      "workspace list": () => ({ stdout: WORKSPACES, stderr: "", exitCode: 0 }),
      "agent list": () => ({ stdout: other, stderr: "", exitCode: 0 }),
    });

    const targets = await loadAgentTargets("repo-agents", herdr, { HERDR_PICKERS_SOURCE_WORKSPACE_ID: "w1" });

    expect(targets).toEqual([]);
  });
});
