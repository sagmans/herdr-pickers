import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

describe("plugin manifest", () => {
  const manifest = Bun.TOML.parse(readFileSync(join(import.meta.dir, "..", "herdr-plugin.toml"), "utf-8")) as {
    id?: string;
    description?: string;
    min_herdr_version?: string;
    version?: string;
    platforms?: string[];
    build?: unknown;
    actions?: Array<{ id?: string; title?: string; contexts?: string[]; command?: string[] }>;
    events?: Array<{ on?: string; command?: string[] }>;
    panes?: Array<{ id?: string; title?: string; placement?: string; width?: string; height?: string; command?: string[] }>;
  };

  test("declares unified plugin metadata", () => {
    expect(manifest.id).toBe("herdr-pickers");
    expect(manifest.description).toBe("Mouse-aware Herdr navigation and agent pickers with fzf-backed ranking.");
    expect(manifest.min_herdr_version).toBe("0.8.0");
    expect(manifest.platforms).toEqual(["macos", "linux"]);
  });

  test("matches standalone package metadata", () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf-8")) as {
      version?: string;
      license?: string;
      private?: boolean;
      dependencies?: Record<string, string>;
    };

    expect(pkg.version).toBe("0.1.0");
    expect(manifest.version).toBe(pkg.version);
    expect(pkg.license).toBe("MIT");
    expect(pkg.private).toBe(true);
    expect(pkg.dependencies).toBeUndefined();
  });

  test("declares no build step", () => {
    expect(manifest.build).toBeUndefined();
  });

  test("declares all eight picker actions through one open entrypoint", () => {
    const pickerActions = manifest.actions?.filter((action) => action.command?.[1] === "src/actions/open.ts") ?? [];

    expect(pickerActions.map((action) => action.id)).toEqual([
      "all",
      "projects",
      "workspaces",
      "repo-workspaces",
      "worktrees",
      "repo-worktrees",
      "agents",
      "repo-agents",
    ]);
    expect(pickerActions.every((action) => action.command?.[0] === "bun")).toBe(true);
  });

  test("scopes repository picker actions to workspaces", () => {
    for (const id of ["repo-workspaces", "repo-worktrees", "repo-agents"]) {
      const action = manifest.actions?.find((candidate) => candidate.id === id);
      expect(action?.contexts).toEqual(["workspace"]);
      expect(action?.command).toEqual(["bun", "src/actions/open.ts", id]);
    }
  });

  test("declares last-workspace action and history events", () => {
    const action = manifest.actions?.find((candidate) => candidate.id === "last-workspace");

    expect(action).toMatchObject({
      title: "Switch to last focused workspace",
      contexts: ["global", "workspace"],
      command: ["bun", "src/actions/last-workspace.ts", "toggle"],
    });
    expect(manifest.events).toEqual([
      { on: "workspace.focused", command: ["bun", "src/actions/last-workspace.ts", "focused"] },
      { on: "workspace.closed", command: ["bun", "src/actions/last-workspace.ts", "closed"] },
    ]);
  });

  test("declares one centered popup pane at 75% of the screen", () => {
    expect(manifest.panes).toEqual([{
      id: "picker",
      title: "Herdr Picker",
      placement: "popup",
      width: "75%",
      height: "75%",
      command: ["bun", "src/pane.ts"],
    }]);
  });
});
