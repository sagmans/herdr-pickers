import { describe, expect, test } from "bun:test";

import { Herdr, type CommandRunner } from "../src/client/herdr.ts";
import { dispatchAgent, dispatchNavigationTarget } from "../src/dispatch.ts";

function recordingHerdr(commands: string[][], failures: readonly string[] = [], stderr = "failed"): Herdr {
  const runner: CommandRunner = async (argv) => {
    const args = [...argv.slice(1)];
    commands.push(args);
    const joined = args.join(" ");
    if (failures.some((failure) => joined.startsWith(failure))) {
      return { stdout: "", stderr, exitCode: 1 };
    }
    return { stdout: '{"result":{}}', stderr: "", exitCode: 0 };
  };
  return new Herdr({ runner });
}

describe("agent dispatch", () => {
  test("focuses the selected agent target", async () => {
    const commands: string[][] = [];
    await dispatchAgent("pane-1", recordingHerdr(commands));
    expect(commands[0]).toEqual(["agent", "focus", "pane-1"]);
  });
});

describe("navigation dispatch", () => {
  test("focuses workspace targets", async () => {
    const commands: string[][] = [];

    await dispatchNavigationTarget({
      kind: "workspace",
      id: "workspace:w1",
      workspaceId: "w1",
      current: false,
      label: "api",
    }, recordingHerdr(commands));

    expect(commands).toEqual([["workspace", "focus", "w1"]]);
  });

  test("projects focus existing workspaces before creating", async () => {
    const commands: string[][] = [];

    await dispatchNavigationTarget({
      kind: "project",
      id: "project:/repo/api",
      path: "/repo/api",
      current: false,
      existingWorkspaceId: "w1",
      label: "api",
    }, recordingHerdr(commands));

    expect(commands).toEqual([["workspace", "focus", "w1"]]);
  });

  test("projects create focused workspaces when unopened", async () => {
    const commands: string[][] = [];

    await dispatchNavigationTarget({
      kind: "project",
      id: "project:/repo/api",
      path: "/repo/api",
      current: false,
      label: "api",
    }, recordingHerdr(commands));

    expect(commands).toEqual([["workspace", "create", "--cwd", "/repo/api", "--label", "api", "--focus"]]);
  });

  test("worktrees focus existing workspaces", async () => {
    const commands: string[][] = [];

    await dispatchNavigationTarget({
      kind: "worktree",
      id: "worktree:/repo/main",
      path: "/repo/main",
      current: false,
      repoRoot: "/repo",
      branch: "main",
      existingWorkspaceId: "w1",
      label: "main",
    }, recordingHerdr(commands));

    expect(commands).toEqual([["workspace", "focus", "w1"]]);
  });

  test("worktrees use Herdr open when linked", async () => {
    const commands: string[][] = [];

    await dispatchNavigationTarget({
      kind: "worktree",
      id: "worktree:/repo/wt",
      path: "/repo/wt",
      current: false,
      repoRoot: "/repo",
      branch: "feat/x",
      label: "feat/x",
    }, recordingHerdr(commands));

    expect(commands).toEqual([["worktree", "open", "--cwd", "/repo", "--path", "/repo/wt", "--json", "--focus"]]);
  });

  test("worktrees fall back only for recognized missing-link errors", async () => {
    const target = {
      kind: "worktree" as const,
      id: "worktree:/repo/wt",
      path: "/repo/wt",
      current: false,
      repoRoot: "/repo",
      branch: "feat/x",
      label: "feat/x",
    };
    const commands: string[][] = [];

    await dispatchNavigationTarget(target, recordingHerdr(commands, ["worktree open"], "worktree not found"));

    expect(commands[1]).toEqual(["workspace", "create", "--cwd", "/repo/wt", "--label", "feat/x", "--focus"]);

const deniedCommands: string[][] = [];
    // Permission failures must stay fail-closed: the generic message no longer
    // carries stderr, so the sanitized stderr field is the classification source.
    const denied = dispatchNavigationTarget(
      target,
      recordingHerdr(deniedCommands, ["worktree open"], "Operation not permitted"),
    );
    await expect(denied).rejects.toThrow("herdr worktree failed (exit 1)");
    await denied.catch((error: unknown) => {
      expect((error as { stderr?: string }).stderr).toBe("Operation not permitted");
    });
    expect(deniedCommands).toHaveLength(1);
  });
});
