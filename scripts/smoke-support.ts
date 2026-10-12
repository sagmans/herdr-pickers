// Shared vocabulary and types for the real-Herdr smoke scripts. Values that
// mirror the plugin come from src so a rename there cannot leave the smoke
// probing a stale name, and the shared types keep the smoke modules free of
// import cycles between each other.
import { CONFIG_FILE_NAME, PLUGIN_ID, type PickerPlacement } from "../src/config/config.ts";
import { PICKER_MODES } from "../src/modes.ts";
import { DATABASE_NAME, READ_REQUEST } from "../src/picker-session.ts";
import { ESCAPE_KEY_SEQUENCE, KEY_CTRL_C, KEY_ENTER } from "../src/terminal-keys.ts";
import { hasErrorCode } from "../src/util/objects.ts";

export { CONFIG_FILE_NAME, KEY_CTRL_C, KEY_ENTER, PLUGIN_ID, READ_REQUEST, type PickerPlacement };
export const KEY_ESCAPE = ESCAPE_KEY_SEQUENCE;
export const OWNERSHIP_DATABASE_NAME = DATABASE_NAME;
// The smoke lists every owner row rather than one session, which the plugin never does.
export const OWNER_QUERY = "SELECT session, token, opener, picker, placement, pane FROM owners";
// Herdr labels the overlay pane with the manifest's popup title.
export const PICKER_PANE_LABEL = "Herdr Picker";
// Pane reads trim trailing blanks, so the probe matches the prompt without them.
export const WORKSPACES_PICKER_PROMPT = PICKER_MODES.workspaces.prompt.trimEnd();

const PROCESS_PROBE_SIGNAL = 0;
const NO_SUCH_PROCESS = "ESRCH";

export interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** One isolated Herdr session plus the attached client the smoke types into. */
export interface SmokeSession {
  readonly label: string;
  readonly rawOutputPath: string;
  run(args: readonly string[]): CliResult;
  runAsync(args: readonly string[]): Promise<CliResult>;
  input(text: string): void;
}

/** Fixtures and harness hooks the entry script hands to the lifecycle cases. */
export interface PickerLifecycleSmokeOptions {
  readonly root: string;
  readonly repo: string;
  readonly pluginConfigDir: string;
  readonly baseConfig: string;
  readonly primary: SmokeSession;
  readonly secondary: SmokeSession;
  readonly firstWorkspaceId: string;
  readonly firstWorkspaceLabel: string;
  readonly dispatchWorkspaceId: string;
  readonly dispatchWorkspaceLabel: string;
  readonly check: (label: string, ok: boolean, detail?: string) => void;
  readonly poll: (label: string, probe: () => string | undefined, timeoutMs?: number) => Promise<string>;
}

/**
 * Picker liveness is what ownership assertions hinge on; a permission error
 * still proves the process exists, so only ESRCH counts as gone.
 */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, PROCESS_PROBE_SIGNAL);
    return true;
  } catch (error) {
    return !hasErrorCode(error, NO_SUCH_PROCESS);
  }
}
