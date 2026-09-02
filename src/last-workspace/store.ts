import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { hasErrorCode } from "../util/objects.ts";
import {
  EMPTY_MEMORY,
  fromPersisted,
  parsePersistedState,
  toPersisted,
  type PersistedState,
  type WorkspaceMemory,
} from "./memory.ts";

const STATE_FILE_NAME = "state.json";
const LOCK_FILE_NAME = "state.lock";
const LOCK_STALE_MILLISECONDS = 10_000;
const LOCK_TIMEOUT_MILLISECONDS = 2_000;
const LOCK_POLL_MILLISECONDS = 25;
const LOCK_BUFFER_BYTES = 4;
const LOCK_BUFFER_INDEX = 0;

export interface StateStoreOptions {
  readonly stateDir: string;
  readonly now?: () => number;
}

export interface LoadedState {
  readonly memory: WorkspaceMemory;
  readonly malformed: boolean;
}

export class StateStore {
  private readonly stateDir: string;
  private readonly now: () => number;

  constructor(options: StateStoreOptions) {
    this.stateDir = options.stateDir;
    this.now = options.now ?? Date.now;
  }

  read(): LoadedState {
    let raw: string;
    try {
      raw = readFileSync(join(this.stateDir, STATE_FILE_NAME), "utf-8");
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) return { memory: EMPTY_MEMORY, malformed: false };
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { memory: EMPTY_MEMORY, malformed: true };
    }

    const state = parsePersistedState(parsed);
    return state === undefined
      ? { memory: EMPTY_MEMORY, malformed: true }
      : { memory: fromPersisted(state), malformed: false };
  }

  write(memory: WorkspaceMemory): void {
    mkdirSync(this.stateDir, { recursive: true });
    const json = `${JSON.stringify(toPersisted(memory, this.now()), null, 2)}\n`;
    const finalPath = join(this.stateDir, STATE_FILE_NAME);
    // A unique temporary file plus atomic rename prevents partial persisted state.
    const tempPath = join(this.stateDir, `.${STATE_FILE_NAME}.tmp.${crypto.randomUUID()}`);
    writeFileSync(tempPath, json, "utf-8");
    try {
      renameSync(tempPath, finalPath);
    } catch (error) {
      try {
        unlinkSync(tempPath);
      } catch (cleanupError) {
        if (!hasErrorCode(cleanupError, "ENOENT")) throw cleanupError;
      }
      throw error;
    }
  }

  update<T>(change: (memory: WorkspaceMemory) => { readonly memory: WorkspaceMemory; readonly value: T }): T {
    mkdirSync(this.stateDir, { recursive: true });
    return withLock(join(this.stateDir, LOCK_FILE_NAME), () => {
      const loaded = this.read();
      const result = change(loaded.memory);
      if (loaded.malformed || result.memory !== loaded.memory) {
        this.write(result.memory);
      }
      return result.value;
    });
  }
}

function withLock<T>(lockPath: string, critical: () => T): T {
  acquireLock(lockPath);
  try {
    return critical();
  } finally {
    try {
      unlinkSync(lockPath);
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT")) throw error;
    }
  }
}

function acquireLock(lockPath: string): void {
  const deadline = Date.now() + LOCK_TIMEOUT_MILLISECONDS;
  for (;;) {
    try {
      const fd = openSync(lockPath, "wx");
      closeSync(fd);
      return;
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) throw error;
    }

    try {
      const mtimeMilliseconds = statSync(lockPath).mtimeMs;
      if (Date.now() - mtimeMilliseconds > LOCK_STALE_MILLISECONDS) {
        unlinkSync(lockPath);
        continue;
      }
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) continue;
      throw error;
    }

    if (Date.now() >= deadline) throw new Error(`timed out acquiring state lock: ${lockPath}`);
    sleepSync(LOCK_POLL_MILLISECONDS);
  }
}

function sleepSync(milliseconds: number): void {
  if (typeof SharedArrayBuffer !== "undefined") {
    try {
      const buffer = new Int32Array(new SharedArrayBuffer(LOCK_BUFFER_BYTES));
      Atomics.wait(buffer, LOCK_BUFFER_INDEX, LOCK_BUFFER_INDEX, milliseconds);
      return;
    } catch {
      // A bounded fallback preserves lock safety on runtimes without Atomics.wait.
    }
  }
  const end = Date.now() + milliseconds;
  while (Date.now() < end) {
    // One-shot event processes have no concurrent work while waiting for state.
  }
}

export function readPersistedStateRaw(stateDir: string): PersistedState | undefined {
  try {
    return parsePersistedState(JSON.parse(readFileSync(join(stateDir, STATE_FILE_NAME), "utf-8")));
  } catch {
    return undefined;
  }
}
