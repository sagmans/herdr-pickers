import { boundedTerminalText } from "../util/terminal-text.ts";

export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export type CommandRunner = (argv: readonly string[], signal?: AbortSignal) => Promise<CommandResult>;

const UNKNOWN_COMMAND_FAMILY = "command";

// Only the leading subcommand word is rendered; argv beyond it can carry
// workspace ids and absolute paths that must never reach terminal output.
function commandFamily(args: readonly string[]): string {
  const family = args.find((arg) => arg.length > 0 && !arg.startsWith("-"));
  return family ? boundedTerminalText(family, 64) : UNKNOWN_COMMAND_FAMILY;
}

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

export class HerdrSpawnError extends Error {
  constructor(cause: unknown) {
    super("Herdr command could not be started.", { cause });
    this.name = "HerdrSpawnError";
  }
}

export class HerdrJsonError extends Error {
  constructor(args: readonly string[]) {
    super(`herdr ${commandFamily(args)} returned invalid JSON`);
    this.name = "HerdrJsonError";
  }
}

export interface HerdrOptions {
  readonly bin?: string;
  readonly runner?: CommandRunner;
  readonly signal?: AbortSignal;
}

export class Herdr {
  private readonly bin: string;
  private readonly runner: CommandRunner;
  private readonly signal: AbortSignal | undefined;

  constructor(options: HerdrOptions = {}) {
    this.bin = options.bin ?? process.env.HERDR_BIN_PATH ?? "herdr";
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

async function runCommand(argv: readonly string[], signal?: AbortSignal): Promise<CommandResult> {
  signal?.throwIfAborted();
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn([...argv], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    // Only failure to create the process proves that no command reached Herdr.
    throw new HerdrSpawnError(error);
  }

  let result: [string, string, number];
  try {
    result = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
  } catch (error) {
    signal?.throwIfAborted();
    throw error;
  }
  signal?.throwIfAborted();
  const [stdout, stderr, exitCode] = result;

  return { stdout, stderr, exitCode };
}
