import { Database } from "bun:sqlite";

import { hasErrorCode } from "../src/util/objects.ts";

// The picker child processes write the ownership database while the smoke reads
// it, so readers must tolerate a writer that holds the lock past the default
// timeout. The busy timeout alone is not enough because Bun surfaces a lock it
// cannot take, so the read is retried instead of failing the run.
const BUSY_TIMEOUT_MILLISECONDS = 10_000;
const READ_ATTEMPTS = 3;
const RETRY_DELAY_MILLISECONDS = 250;
const LOCK_ERROR_PATTERN = /busy|locked/i;

/** Runs a read-only query against the picker ownership database, retrying while a writer burst holds its lock. */
export function readOwnershipDatabase<T>(path: string, query: (database: Database) => T): T {
  let lastError: unknown;
  for (let attempt = 1; attempt <= READ_ATTEMPTS; attempt += 1) {
    const database = new Database(path, { readonly: true });
    try {
      database.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MILLISECONDS}`);
      return query(database);
    } catch (error) {
      lastError = error;
      if (!isLockError(error)) throw error;
      if (attempt < READ_ATTEMPTS) Bun.sleepSync(RETRY_DELAY_MILLISECONDS);
    } finally {
      database.close();
    }
  }
  throw lastError;
}

function isLockError(error: unknown): boolean {
  if (hasErrorCode(error, "SQLITE_BUSY") || hasErrorCode(error, "SQLITE_LOCKED")) return true;
  return error instanceof Error && LOCK_ERROR_PATTERN.test(error.message);
}
