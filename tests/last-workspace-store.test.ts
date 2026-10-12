import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { EMPTY_MEMORY, type WorkspaceMemory } from "../src/last-workspace/memory.ts";
import { StateStore, readPersistedStateRaw } from "../src/last-workspace/store.ts";

const TEMP_PREFIX = "herdr-pickers-last-ws-";
const CURRENT_W2_LAST_W1: WorkspaceMemory = { kind: "current", current: "w2", last: "w1" };
const LOCK_DATABASE_NAME = "state.lock.sqlite";

function tempStateDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `${TEMP_PREFIX}${label}-`));
}

describe("StateStore.read", () => {
  test("missing state yields non-malformed empty memory", () => {
    const store = new StateStore({ stateDir: tempStateDir("missing") });
    const loaded = store.read();

    expect(loaded.memory).toEqual(EMPTY_MEMORY);
    expect(loaded.malformed).toBe(false);
  });

  test("round-trips written memory", () => {
    const dir = tempStateDir("roundtrip");
    const store = new StateStore({ stateDir: dir });

    store.write(CURRENT_W2_LAST_W1);

    expect(store.read()).toEqual({ memory: CURRENT_W2_LAST_W1, malformed: false });
  });

  test("flags malformed JSON values for repair", () => {
    const corruptDir = tempStateDir("corrupt");
    const nonObjectDir = tempStateDir("nonobject");
    writeFileSync(join(corruptDir, "state.json"), "not json {", "utf-8");
    writeFileSync(join(nonObjectDir, "state.json"), "[]", "utf-8");

    expect(new StateStore({ stateDir: corruptDir }).read()).toEqual({ memory: EMPTY_MEMORY, malformed: true });
    expect(new StateStore({ stateDir: nonObjectDir }).read()).toEqual({ memory: EMPTY_MEMORY, malformed: true });
  });
});

describe("StateStore.update", () => {
  test("returns values and persists changed memory", () => {
    const dir = tempStateDir("update-change");
    const store = new StateStore({ stateDir: dir });

    const result = store.update(() => ({ memory: CURRENT_W2_LAST_W1, value: 42 }));

    expect(result).toBe(42);
    expect(readPersistedStateRaw(dir)).toMatchObject({ current_workspace_id: "w2", last_workspace_id: "w1" });
  });

  test("repairs malformed state during no-op update", () => {
    const dir = tempStateDir("repair");
    writeFileSync(join(dir, "state.json"), "broken", "utf-8");
    const store = new StateStore({ stateDir: dir });

    store.update((memory) => ({ memory, value: undefined }));

    expect(readPersistedStateRaw(dir)).toEqual(expect.objectContaining({ updated_unix_ms: expect.any(Number) }));
  });

  test("leaves no temporary files after writes", () => {
    const dir = tempStateDir("clean-temp");
    new StateStore({ stateDir: dir }).write(CURRENT_W2_LAST_W1);

    expect(readdirSync(dir).filter((name) => name.startsWith(".state.json.tmp."))).toEqual([]);
  });

  test("resets an unreadable lock file once so the feature heals itself", () => {
    const dir = tempStateDir("broken-lock");
    writeFileSync(join(dir, LOCK_DATABASE_NAME), "not a database", "utf-8");
    const store = new StateStore({ stateDir: dir });

    expect(store.update(() => ({ memory: CURRENT_W2_LAST_W1, value: "saved" }))).toBe("saved");
    expect(readPersistedStateRaw(dir)).toMatchObject({ current_workspace_id: "w2", last_workspace_id: "w1" });
    // The reset is permanent: the same file now opens as a valid empty database.
    expect(store.update(() => ({ memory: CURRENT_W2_LAST_W1, value: "again" }))).toBe("again");
  });

  test("reports lock contention as a timeout with its SQLite cause", () => {
    const dir = tempStateDir("busy-lock");
    const holder = new Database(join(dir, LOCK_DATABASE_NAME));
    try {
      holder.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
      let failure: unknown;
      try {
        new StateStore({ stateDir: dir }).update(() => ({ memory: EMPTY_MEMORY, value: undefined }));
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain("timed out acquiring state lock");
      expect((failure as Error).cause).toMatchObject({ code: "SQLITE_BUSY" });
    } finally {
      holder.close();
    }
  }, 10_000);
});
