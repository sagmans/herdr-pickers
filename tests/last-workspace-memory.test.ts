import { describe, expect, test } from "bun:test";

import type { WorkspaceRecord } from "../src/client/types.ts";
import {
  EMPTY_MEMORY,
  applyClosed,
  applyFocused,
  containsWorkspace,
  focusedWorkspaceId,
  fromPersisted,
  parsePersistedState,
  resolveClosedJump,
  resolveToggle,
  toPersisted,
  type WorkspaceMemory,
} from "../src/last-workspace/memory.ts";

function workspaces(...rows: Array<readonly [string, boolean]>): WorkspaceRecord[] {
  return rows.map(([workspaceId, focused]) => ({ workspaceId, focused }));
}

const EMPTY: WorkspaceMemory = { kind: "empty" };

describe("workspace memory helpers", () => {
  test("finds focused and existing workspaces", () => {
    const list = workspaces(["w1", false], ["w2", true]);

    expect(focusedWorkspaceId(list)).toBe("w2");
    expect(focusedWorkspaceId(workspaces(["w1", false]))).toBeUndefined();
    expect(containsWorkspace(list, "w2")).toBe(true);
    expect(containsWorkspace(list, "w9")).toBe(false);
  });
});

describe("persisted workspace memory", () => {
  test("missing or invalid current state yields empty memory", () => {
    expect(fromPersisted(undefined)).toEqual(EMPTY);
    expect(fromPersisted({})).toEqual(EMPTY);
    expect(fromPersisted({ current_workspace_id: "" })).toEqual(EMPTY);
    expect(fromPersisted({ last_workspace_id: "w1" })).toEqual(EMPTY);
  });

  test("drops a last workspace equal to current", () => {
    expect(fromPersisted({ current_workspace_id: "w1", last_workspace_id: "w1" })).toEqual({
      kind: "current",
      current: "w1",
      last: undefined,
    });
  });

  test("round-trips valid memory", () => {
    const cases: WorkspaceMemory[] = [
      EMPTY,
      { kind: "current", current: "w1", last: undefined },
      { kind: "current", current: "w1", last: "w2" },
    ];

    for (const memory of cases) {
      expect(fromPersisted(toPersisted(memory, 123))).toEqual(memory);
    }
  });

  test("parses records while ignoring extras and wrong field types", () => {
    expect(parsePersistedState("not-an-object")).toBeUndefined();
    expect(parsePersistedState(null)).toBeUndefined();
    expect(parsePersistedState([])).toBeUndefined();
    expect(parsePersistedState({ current_workspace_id: "w1", last_workspace_id: "w2", extra: true })).toEqual({
      current_workspace_id: "w1",
      last_workspace_id: "w2",
    });
    expect(parsePersistedState({ current_workspace_id: 5, last_workspace_id: "w2" })).toEqual({ last_workspace_id: "w2" });
  });
});

describe("focus transitions", () => {
  test("seeds empty memory and moves prior current into last", () => {
    expect(applyFocused(EMPTY, "w1", "w1")).toEqual({ kind: "current", current: "w1", last: undefined });
    expect(applyFocused({ kind: "current", current: "w1", last: undefined }, "w2", "w2")).toEqual({
      kind: "current",
      current: "w2",
      last: "w1",
    });
  });

  test("ignores unchanged and stale focus events", () => {
    const memory: WorkspaceMemory = { kind: "current", current: "w1", last: "w0" };

    expect(applyFocused(memory, "w1", "w1")).toBe(memory);
    expect(applyFocused(memory, "w2", "w1")).toBe(memory);
  });
});

describe("close transitions", () => {
  test("clears a closed last workspace", () => {
    const memory: WorkspaceMemory = { kind: "current", current: "w2", last: "w1" };

    expect(applyClosed(memory, "w1", "w2")).toEqual({ kind: "current", current: "w2", last: undefined });
  });

  test("moves current to live focus when current closes", () => {
    const memory: WorkspaceMemory = { kind: "current", current: "w1", last: "w2" };

    expect(applyClosed(memory, "w1", "w3")).toEqual({ kind: "current", current: "w3", last: "w2" });
    expect(applyClosed(memory, "w1", "w2")).toEqual({ kind: "current", current: "w2", last: undefined });
    expect(applyClosed(memory, "w1", undefined)).toEqual(EMPTY);
  });

  test("leaves empty and unrelated history unchanged", () => {
    const memory: WorkspaceMemory = { kind: "current", current: "w1", last: "w2" };

    expect(applyClosed(EMPTY, "w1", "w2")).toEqual(EMPTY);
    expect(applyClosed(memory, "w9", "w1")).toBe(memory);
  });
});

describe("toggle resolution", () => {
  const exists = (ids: readonly string[]) => (id: string) => ids.includes(id);

  test("seeds current without focusing when memory is empty", () => {
    expect(resolveToggle(EMPTY, "w1", exists(["w1"]))).toEqual({
      memory: { kind: "current", current: "w1", last: undefined },
      target: undefined,
    });
  });

  test("focuses a valid remembered workspace", () => {
    const memory: WorkspaceMemory = { kind: "current", current: "w2", last: "w1" };

    expect(resolveToggle(memory, "w2", exists(["w1", "w2"]))).toEqual({ memory, target: "w1" });
  });

  test("clears stale or current last targets", () => {
    const stale: WorkspaceMemory = { kind: "current", current: "w2", last: "w1" };
    const duplicate: WorkspaceMemory = { kind: "current", current: "w2", last: "w2" };

    expect(resolveToggle(stale, "w2", exists(["w2"]))).toEqual({
      memory: { kind: "current", current: "w2", last: undefined },
      target: undefined,
    });
    expect(resolveToggle(duplicate, "w2", exists(["w2"]))).toEqual({
      memory: { kind: "current", current: "w2", last: undefined },
      target: undefined,
    });
  });

  test("re-syncs current and ignores missing live focus", () => {
    const memory: WorkspaceMemory = { kind: "current", current: "w0", last: undefined };

    expect(resolveToggle(memory, "w2", exists(["w2"]))).toEqual({
      memory: { kind: "current", current: "w2", last: undefined },
      target: undefined,
    });
    expect(resolveToggle(memory, undefined, exists(["w0"]))).toEqual({ memory, target: undefined });
  });
});

describe("close jump resolution", () => {
  const exists = (ids: readonly string[]) => (id: string) => ids.includes(id);

  test("returns previous workspace when closed workspace was focused and previous is live", () => {
    const memory: WorkspaceMemory = { kind: "current", current: "w1", last: "w2" };

    expect(resolveClosedJump(memory, "w1", "w3", exists(["w2", "w3"]))).toBe("w2");
  });

  test("returns undefined when closing a non-focused workspace", () => {
    const memory: WorkspaceMemory = { kind: "current", current: "w1", last: "w2" };

    expect(resolveClosedJump(memory, "w2", "w1", exists(["w1"]))).toBeUndefined();
    expect(resolveClosedJump(memory, "w9", "w1", exists(["w1", "w2"]))).toBeUndefined();
  });

  test("returns undefined when memory is empty or previous workspace is undefined", () => {
    expect(resolveClosedJump(EMPTY, "w1", "w2", exists(["w2"]))).toBeUndefined();
    expect(
      resolveClosedJump({ kind: "current", current: "w1", last: undefined }, "w1", "w2", exists(["w2"])),
    ).toBeUndefined();
  });

  test("returns undefined when previous workspace no longer exists", () => {
    const memory: WorkspaceMemory = { kind: "current", current: "w1", last: "w2" };

    expect(resolveClosedJump(memory, "w1", "w3", exists(["w3"]))).toBeUndefined();
  });

  test("returns undefined when previous workspace is already the landing focus", () => {
    const memory: WorkspaceMemory = { kind: "current", current: "w1", last: "w2" };

    expect(resolveClosedJump(memory, "w1", "w2", exists(["w2"]))).toBeUndefined();
  });
});
