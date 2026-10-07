import { Database } from "bun:sqlite";
import { closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
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
// SQLite holds its write lock through the kernel, so the lock dies with its
// holder and is never broken by age. Path-based stale breaking cannot verify
// ownership atomically: one waiter could unlink a lock that another waiter or
// a slow holder had just made fresh, and two writers would then overlap.
const LOCK_DATABASE_NAME = "state.lock.sqlite";
const LOCK_TIMEOUT_MILLISECONDS = 2_000;
const LOCK_FILE_MODE = 0o600;
const ACQUIRE_LOCK = "BEGIN IMMEDIATE";
// No row is ever written, so rollback only releases the lock.
const RELEASE_LOCK = "ROLLBACK";

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
    return withLock(join(this.stateDir, LOCK_DATABASE_NAME), () => {
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
  const database = openLockDatabase(lockPath);
  try {
    try {
      database.exec(ACQUIRE_LOCK);
    } catch (error) {
      throw new Error(`timed out acquiring state lock: ${lockPath}`, { cause: error });
    }
    try {
      return critical();
    } finally {
      database.exec(RELEASE_LOCK);
    }
  } finally {
    database.close();
  }
}

function openLockDatabase(lockPath: string): Database {
  // O_NOFOLLOW keeps a planted symlink from redirecting SQLite to another file.
  const fd = openSync(lockPath, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, LOCK_FILE_MODE);
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`state lock is not a regular file: ${lockPath}`);
  } finally {
    closeSync(fd);
  }
  const database = new Database(lockPath);
  try {
    database.exec(`PRAGMA busy_timeout = ${LOCK_TIMEOUT_MILLISECONDS}`);
  } catch (error) {
    database.close();
    throw error;
  }
  return database;
}

export function readPersistedStateRaw(stateDir: string): PersistedState | undefined {
  try {
    return parsePersistedState(JSON.parse(readFileSync(join(stateDir, STATE_FILE_NAME), "utf-8")));
  } catch {
    return undefined;
  }
}
