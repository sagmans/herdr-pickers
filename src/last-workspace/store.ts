// Durable previous-workspace state shared by concurrent hook and action
// processes. Read-modify-write runs under a kernel-held SQLite lock and
// writes are atomic renames, so racing events never corrupt or interleave.
import { Database } from "bun:sqlite";
import { closeSync, constants, fchmodSync, fstatSync, ftruncateSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
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
// Only contention may be reported as a timeout; other failures keep their own
// diagnosis so a broken lock file is not mistaken for a slow peer.
const LOCK_BUSY_CODE = "SQLITE_BUSY";
// A lock file that SQLite cannot read as a database would otherwise fail every
// later hook forever. It never holds data, so it can be reset and retried.
const UNREADABLE_LOCK_CODES: readonly string[] = ["SQLITE_NOTADB", "SQLITE_CORRUPT"];
// SQLite accepts a zero-length file as an empty database.
const EMPTY_LOCK_SIZE = 0;

/** `now` is injectable so persisted timestamps are deterministic in tests. */
export interface StateStoreOptions {
  readonly stateDir: string;
  readonly now?: () => number;
}

/** `malformed` forces a rewrite even when memory is otherwise unchanged. */
export interface LoadedState {
  readonly memory: WorkspaceMemory;
  readonly malformed: boolean;
}

/** Single owner of state.json; use update() for any read-modify-write. */
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
  const database = acquireLock(lockPath);
  try {
    try {
      return critical();
    } finally {
      database.exec(RELEASE_LOCK);
    }
  } finally {
    database.close();
  }
}

// One reset is enough: an unreadable file becomes a valid empty database, so a
// second unreadable failure means something else is wrong and must surface.
function acquireLock(lockPath: string): Database {
  try {
    return openAndLock(lockPath);
  } catch (error) {
    if (!isUnreadableLock(error)) throw error;
    resetLockFile(lockPath);
    return openAndLock(lockPath);
  }
}

function openAndLock(lockPath: string): Database {
  const database = openLockDatabase(lockPath);
  try {
    database.exec(ACQUIRE_LOCK);
  } catch (error) {
    database.close();
    if (hasErrorCode(error, LOCK_BUSY_CODE)) {
      throw new Error(`timed out acquiring state lock: ${lockPath}`, { cause: error });
    }
    throw error;
  }
  return database;
}

function isUnreadableLock(error: unknown): boolean {
  return UNREADABLE_LOCK_CODES.some((code) => hasErrorCode(error, code));
}

// Truncating in place keeps the same inode. Replacing the file would let a
// peer that already opened the fresh file and a peer that opens the
// replacement hold separate locks and run their critical sections together.
// Truncation is idempotent because no lock holder ever writes to the file.
// O_CREAT only applies the private mode to new files, so a reset file whose
// origin is unknown is narrowed explicitly.
function resetLockFile(lockPath: string): void {
  const fd = openRegularLockFile(lockPath);
  try {
    ftruncateSync(fd, EMPTY_LOCK_SIZE);
    fchmodSync(fd, LOCK_FILE_MODE);
  } finally {
    closeSync(fd);
  }
}

// O_NOFOLLOW keeps a planted symlink from redirecting SQLite or a reset to
// another file; the caller owns closing the returned descriptor.
function openRegularLockFile(lockPath: string): number {
  const fd = openSync(lockPath, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, LOCK_FILE_MODE);
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`state lock is not a regular file: ${lockPath}`);
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  return fd;
}

function openLockDatabase(lockPath: string): Database {
  closeSync(openRegularLockFile(lockPath));
  const database = new Database(lockPath);
  try {
    database.exec(`PRAGMA busy_timeout = ${LOCK_TIMEOUT_MILLISECONDS}`);
  } catch (error) {
    database.close();
    throw error;
  }
  return database;
}

/** Lock-free view of the raw file for inspection (tests); any failure yields undefined. */
export function readPersistedStateRaw(stateDir: string): PersistedState | undefined {
  try {
    return parsePersistedState(JSON.parse(readFileSync(join(stateDir, STATE_FILE_NAME), "utf-8")));
  } catch {
    return undefined;
  }
}
