// Cross-process picker ownership for one Herdr session, kept in a private SQLite
// file. Openers (actions/open.ts) reserve and post requests; the picker pane
// (pane.ts) claims and acknowledges them, so at most one picker surface exists.
import { Database } from "bun:sqlite";
import { closeSync, constants, fstatSync, mkdirSync, openSync, realpathSync, lstatSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import type { CurrentContext } from "./context.ts";
import type { PickerMode } from "./modes.ts";
import { encodeRequestContext, readPickerRequest, type PickerRequest } from "./picker-request.ts";
import type { PickerPlacement } from "./config/config.ts";
import { POPUP_SURFACE, type PickerSurface } from "./client/popup.ts";
import { hasErrorCode } from "./util/objects.ts";

/** Pane env var carrying the reservation token from opener to the spawned picker. */
export const PICKER_TOKEN_ENV = "HERDR_PICKERS_SESSION_TOKEN";
/** How often openers and pickers re-read the request mailbox; short enough to feel instant. */
export const PICKER_REQUEST_POLL_MS = 25;
/** How long an opener waits for a picker to take its request before reporting failure. */
export const PICKER_REQUEST_TIMEOUT_MS = 3_000;
/** Exported so the real-Herdr smoke can locate the database the plugin owns. */
export const DATABASE_NAME = "picker-sessions.sqlite";
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const FILE_PERMISSION_MASK = 0o777;
const PROBE_SIGNAL = 0;
// A dead opener's unclaimed reservation stays authoritative for this long so a
// slow-starting child can still claim it. It is well beyond the opener's
// PICKER_REQUEST_TIMEOUT_MS delivery deadline; afterwards the token-guarded claim makes any
// late child exit without UI, so reclaiming cannot create a duplicate surface.
const UNCLAIMED_RESERVATION_GRACE_MS = 10_000;
const RESERVED_AT_COLUMN = "reserved_at";
// Openers and pickers contend only for single-row writes, so a short wait
// absorbs contention without stalling an opener past its delivery deadline.
const SQLITE_BUSY_TIMEOUT_MS = 2_000;
const SCHEMA = `
  PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS};
  CREATE TABLE IF NOT EXISTS owners (
    session TEXT PRIMARY KEY, token TEXT NOT NULL, opener INTEGER NOT NULL,
    picker INTEGER, placement TEXT NOT NULL CHECK (placement IN ('popup', 'overlay')), pane TEXT,
    reserved_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS requests (
    session TEXT PRIMARY KEY, token TEXT NOT NULL, mode TEXT NOT NULL,
    context TEXT NOT NULL, acknowledged TEXT
  );
`;
const READ_OWNER = "SELECT * FROM owners WHERE session = ?";
/** Exported so the smoke observes requests through the same query the plugin reads. */
export const READ_REQUEST = "SELECT * FROM requests WHERE session = ?";
const WRITE_REQUEST = `INSERT INTO requests (session, token, mode, context) VALUES (?, ?, ?, ?)
  ON CONFLICT(session) DO UPDATE SET token=excluded.token, mode=excluded.mode, context=excluded.context, acknowledged=NULL`;
const ACK_REQUEST = `UPDATE requests SET acknowledged=? WHERE session=? AND token=?
  AND EXISTS (SELECT 1 FROM owners WHERE session=? AND token=? AND picker=?)`;
const INSERT_OWNER = "INSERT INTO owners (session, token, opener, placement, reserved_at) VALUES (?, ?, ?, ?, ?)";
const OWNER_COLUMNS = "PRAGMA table_info(owners)";
const ADD_RESERVED_AT = `ALTER TABLE owners ADD COLUMN ${RESERVED_AT_COLUMN} INTEGER`;
const DELETE_OWNER = "DELETE FROM owners WHERE session = ? AND token = ?";
const RELEASE_UNSUBMITTED = "DELETE FROM owners WHERE session = ? AND token = ? AND opener = ? AND picker IS NULL";
const CLAIM_OWNER = "UPDATE owners SET picker = ?, pane = ? WHERE session = ? AND token = ? AND picker IS NULL AND placement = ?";
const MILLISECONDS_PER_SECOND = 1_000;
// Users only see this after an opener's whole delivery deadline, so it names
// the wait that actually unblocks them instead of an internal state.
const UNCERTAIN_STARTUP = "Picker startup is pending. Retry after the earlier picker opens, or after "
  + `${UNCLAIMED_RESERVATION_GRACE_MS / MILLISECONDS_PER_SECOND} seconds when its reservation expires.`;

/** A reserved picker may still start; openers wait rather than risk a duplicate surface. */
export class PickerStartupUncertainError extends Error {
  constructor() { super(UNCERTAIN_STARTUP); }
}

interface Owner {
  readonly token: string;
  readonly opener: number;
  readonly picker: number | null;
  readonly placement: PickerPlacement;
  readonly pane: string | null;
  readonly reserved_at: number | null;
}

/**
 * Session-scoped handle to the ownership database, keyed by the Herdr socket identity.
 * Throws at construction when the socket or storage file fails the privacy checks.
 */
export class PickerSession {
  private readonly database: Database;
  private readonly session: string;

  constructor(env: Record<string, string | undefined>) {
    const stateDir = env.HERDR_PLUGIN_STATE_DIR;
    const socketPath = env.HERDR_SOCKET_PATH;
    if (!stateDir || !socketPath) throw new Error("Herdr plugin state and session socket are required for picker ownership.");
    const canonicalSocket = join(realpathSync(dirname(socketPath)), basename(socketPath));
    const socket = lstatSync(canonicalSocket, { bigint: true });
    if (!socket.isSocket()) throw new Error("Picker session identity must be a Herdr socket.");
    this.session = JSON.stringify([canonicalSocket, String(socket.dev), String(socket.ino), String(socket.birthtimeNs)]);
    mkdirSync(stateDir, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    const path = join(stateDir, DATABASE_NAME);
    const fd = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, PRIVATE_FILE_MODE);
    try {
      const file = fstatSync(fd);
      if (!file.isFile() || (file.mode & PRIVATE_FILE_MODE) !== PRIVATE_FILE_MODE || (file.mode & ~PRIVATE_FILE_MODE & FILE_PERMISSION_MASK) !== 0) {
        throw new Error("Picker ownership storage must be a private regular file.");
      }
    } finally {
      closeSync(fd);
    }
    this.database = new Database(path);
    try {
      this.database.exec(SCHEMA);
      this.migrate();
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  async reserve(placement: PickerPlacement, paneExists: (paneId: string) => Promise<boolean>): Promise<string | undefined> {
    const observed = this.read();
    if (observed) {
      if (ownerAlive(observed)) return undefined;
      // An opener can die after submitting a request but before the child claims it;
      // only a reservation past its grace period is treated as abandoned.
      if (observed.picker === null) {
        if (!reservationExpired(observed)) throw new PickerStartupUncertainError();
      } else if (observed.placement === "overlay") {
        if (!observed.pane) throw new PickerStartupUncertainError();
        if (await paneExists(observed.pane)) return undefined;
      }
    }
    return this.database.transaction(() => {
      const current = this.read();
      if (current) {
        // Recheck after the external observation so a late claim cannot be reaped.
        if (!observed || current.token !== observed.token || current.picker !== observed.picker
          || current.pane !== observed.pane || ownerAlive(current)) return undefined;
        this.database.query(DELETE_OWNER).run(this.session, current.token);
      }
      const token = crypto.randomUUID();
      this.database.query(INSERT_OWNER).run(this.session, token, process.pid, placement, Date.now());
      return token;
    }).immediate();
  }

  releaseUnsubmitted(token: string): void {
    this.database.query(RELEASE_UNSUBMITTED).run(this.session, token, process.pid);
  }

  request(mode: PickerMode, context: CurrentContext): PickerRequest {
    return this.database.transaction(() => {
      const owner = this.read();
      const previous = this.latestRequest();
      // Actions invoked from an overlay must not turn the plugin's pane into the source repository.
      const source = owner?.pane && context.paneId === owner.pane && previous ? previous.context : context;
      const token = crypto.randomUUID();
      this.database.query(WRITE_REQUEST).run(this.session, token, mode, encodeRequestContext(source));
      return this.latestRequest()!;
    }).immediate();
  }

  latestRequest(): PickerRequest | undefined {
    const row = this.database.query(READ_REQUEST).get(this.session);
    return row ? readPickerRequest(row) : undefined;
  }

  acknowledge(request: string, owner: string): boolean {
    return this.database.query(ACK_REQUEST).run(owner, this.session, request, this.session, owner, process.pid).changes === 1;
  }

  claim(token: string, surface: PickerSurface = POPUP_SURFACE): boolean {
    const paneId = surface.placement === "overlay" ? surface.paneId : null;
    return this.database.query(CLAIM_OWNER).run(process.pid, paneId, this.session, token, surface.placement).changes === 1;
  }

  close(): void {
    // The next opener verifies process death; returning from cleanup is too early.
    this.database.close();
  }

  // Databases created before reservation timestamps keep their table because
  // CREATE TABLE IF NOT EXISTS never alters it; concurrent openers serialize here.
  // The unlocked probe keeps every later open free of a write lock.
  private migrate(): void {
    if (this.hasReservedAt()) return;
    this.database.transaction(() => {
      if (!this.hasReservedAt()) this.database.exec(ADD_RESERVED_AT);
    }).immediate();
  }

  private hasReservedAt(): boolean {
    return this.database.query<{ name: string }, []>(OWNER_COLUMNS).all().some(column => column.name === RESERVED_AT_COLUMN);
  }

  private read(): Owner | null {
    return this.database.query<Owner, [string]>(READ_OWNER).get(this.session);
  }
}

function ownerAlive(owner: Owner): boolean {
  // ponytail: PID reuse fails closed; add process birth identities if restart recovery becomes frequent.
  return processAlive(owner.opener) || (owner.picker !== null && processAlive(owner.picker));
}

function reservationExpired(owner: Owner): boolean {
  // Legacy rows have no timestamp; callers reach this only after the opener is proven dead.
  return owner.reserved_at === null || Date.now() - owner.reserved_at > UNCLAIMED_RESERVATION_GRACE_MS;
}

function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid picker owner process identity.");
  try {
    process.kill(pid, PROBE_SIGNAL);
    return true;
  } catch (error) {
    if (hasErrorCode(error, "ESRCH")) return false;
    throw error;
  }
}
