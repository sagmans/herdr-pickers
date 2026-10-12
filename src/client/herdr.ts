// Herdr CLI boundary: every plugin call to Herdr goes through this argv-only
// runner so failures surface as typed, sanitized errors and cancellation is
// honored. JSON payloads it returns are parsed in ./types.ts.
import { runArgv, type CommandResult, type CommandRunner } from "../util/subprocess.ts";
import { boundedTerminalText } from "../util/terminal-text.ts";

const UNKNOWN_COMMAND_FAMILY = "command";
// A subcommand word is short; the cap only stops a hostile argv from flooding errors.
const MAX_COMMAND_FAMILY_LENGTH = 64;
const DEFAULT_HERDR_BIN = "herdr";

/**
 * Herdr exports HERDR_BIN_PATH to plugins so every invocation reaches the same
 * binary, and therefore the same protocol version, that launched the plugin.
 */
export function herdrBinary(): string {
  return process.env.HERDR_BIN_PATH ?? DEFAULT_HERDR_BIN;
}

// Only the leading subcommand word is rendered; argv beyond it can carry
// workspace ids and absolute paths that must never reach terminal output.
function commandFamily(args: readonly string[]): string {
  const family = args.find((arg) => arg.length > 0 && !arg.startsWith("-"));
  return family ? boundedTerminalText(family, MAX_COMMAND_FAMILY_LENGTH) : UNKNOWN_COMMAND_FAMILY;
}

/** Herdr ran and exited non-zero, so the command may have taken partial effect. */
export class HerdrCommandError extends Error {
  // Bounded sanitized stderr stays available because dispatch classifies
  // recoverable worktree failures from it.
  readonly stderr: string;

  constructor(args: readonly string[], exitCode: number, stderr: string) {
    super(`herdr ${commandFamily(args)} failed (exit ${exitCode})`);
    this.name = "HerdrCommandError";
    this.stderr = boundedTerminalText(stderr);
  }
}

/** The Herdr process never started, so callers may treat the request as not delivered. */
export class HerdrSpawnError extends Error {
  constructor(cause: unknown) {
    super("Herdr command could not be started.", { cause });
    this.name = "HerdrSpawnError";
  }
}

/** Herdr succeeded but stdout was not JSON; the message names only the command family. */
export class HerdrJsonError extends Error {
  constructor(args: readonly string[]) {
    super(`herdr ${commandFamily(args)} returned invalid JSON`);
    this.name = "HerdrJsonError";
  }
}

/** Overrides for tests and cancellation; defaults target the launching Herdr binary. */
export interface HerdrOptions {
  readonly bin?: string;
  readonly runner?: CommandRunner;
  readonly signal?: AbortSignal;
}

/**
 * Herdr CLI client. Aborting `signal` rejects with the abort reason instead of
 * a command error, so cancelled pickers do not report spurious failures.
 */
export class Herdr {
  private readonly bin: string;
  private readonly runner: CommandRunner;
  private readonly signal: AbortSignal | undefined;

  constructor(options: HerdrOptions = {}) {
    this.bin = options.bin ?? herdrBinary();
    this.runner = options.runner ?? runCommand;
    this.signal = options.signal;
  }

  async run(args: readonly string[]): Promise<string> {
    this.signal?.throwIfAborted();
    let result: CommandResult;
    try {
      result = await this.runner([this.bin, ...args], this.signal);
    } catch (error) {
      this.signal?.throwIfAborted();
      throw error;
    }
    this.signal?.throwIfAborted();
    if (result.exitCode !== 0) {
      throw new HerdrCommandError(args, result.exitCode, result.stderr.trim());
    }
    return result.stdout;
  }

  async json(args: readonly string[]): Promise<unknown> {
    const stdout = await this.run(args);
    try {
      return JSON.parse(stdout) as unknown;
    } catch {
      throw new HerdrJsonError(args);
    }
  }
}

// Only failure to create the process proves that no command reached Herdr.
function runCommand(argv: readonly string[], signal?: AbortSignal): Promise<CommandResult> {
  return runArgv(argv, { signal, spawnError: (cause) => new HerdrSpawnError(cause) });
}
