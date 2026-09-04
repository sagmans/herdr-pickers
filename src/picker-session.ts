import { Database } from "bun:sqlite";
import { closeSync, constants, fstatSync, mkdirSync, openSync, realpathSync, lstatSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import type { PickerPlacement } from "./config/config.ts";
import { hasErrorCode } from "./util/objects.ts";

export const PICKER_TOKEN_ENV = "HERDR_PICKERS_SESSION_TOKEN";
const DATABASE_NAME = "picker-sessions.sqlite";
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const FILE_PERMISSION_MASK = 0o777;
const PROBE_SIGNAL = 0;
const SCHEMA = `
  PRAGMA busy_timeout = 2000;
  CREATE TABLE IF NOT EXISTS owners (
    session TEXT PRIMARY KEY, token TEXT NOT NULL, opener INTEGER NOT NULL,
    picker INTEGER, placement TEXT NOT NULL CHECK (placement IN ('popup', 'overlay')), pane TEXT
  );
`;
const READ_OWNER = "SELECT * FROM owners WHERE session = ?";
const INSERT_OWNER = "INSERT INTO owners (session, token, opener, placement) VALUES (?, ?, ?, ?)";
const DELETE_OWNER = "DELETE FROM owners WHERE session = ? AND token = ?";
const CLAIM_OWNER = "UPDATE owners SET picker = ?, pane = ? WHERE session = ? AND token = ? AND picker IS NULL AND placement = ?";
const UNCERTAIN_STARTUP = "Picker startup could not be verified. Restart this Herdr session before opening another picker.";

interface Owner {
  readonly token: string;
  readonly opener: number;
  readonly picker: number | null;
  readonly placement: PickerPlacement;
  readonly pane: string | null;
}

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
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  async reserve(placement: PickerPlacement, paneExists: (paneId: string) => Promise<boolean>): Promise<string | undefined> {
    const observed = this.read();
    if (observed) {
      if (ownerAlive(observed)) return undefined;
      // An opener can die after submitting a request but before the child claims it.
      if (observed.picker === null) throw new Error(UNCERTAIN_STARTUP);
      if (observed.placement === "overlay") {
        if (!observed.pane) throw new Error(UNCERTAIN_STARTUP);
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
      this.database.query(INSERT_OWNER).run(this.session, token, process.pid, placement);
      return token;
    }).immediate();
  }

  claim(token: string, paneId?: string): boolean {
    const placement: PickerPlacement = paneId ? "overlay" : "popup";
    return this.database.query(CLAIM_OWNER).run(process.pid, paneId ?? null, this.session, token, placement).changes === 1;
  }

  close(): void {
    // The next opener verifies process death; returning from cleanup is too early.
    this.database.close();
  }

  private read(): Owner | null {
    return this.database.query<Owner, [string]>(READ_OWNER).get(this.session);
  }
}

function ownerAlive(owner: Owner): boolean {
  // ponytail: PID reuse fails closed; add process birth identities if restart recovery becomes frequent.
  return processAlive(owner.opener) || (owner.picker !== null && processAlive(owner.picker));
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
