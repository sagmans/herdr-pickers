// The one child-process boundary for Herdr, Git, and the native snapshot client.
// Every caller needs the same contract: argv only (no shell), an abort surfaces
// as the signal's own reason rather than a wrapped command failure, and no child
// outlives the call that started it.

export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/** Injection seam so callers and tests can replace process execution wholesale. */
export type CommandRunner = (argv: readonly string[], signal?: AbortSignal) => Promise<CommandResult>;

/** Caps stdout for callers reading output that an untrusted peer controls. */
export interface OutputLimit {
  readonly bytes: number;
  readonly error: () => Error;
}

export interface RunArgvOptions {
  readonly signal?: AbortSignal | undefined;
  readonly env?: Record<string, string | undefined> | undefined;
  readonly stdoutLimit?: OutputLimit | undefined;
  /**
   * Lets a caller mark spawn failure distinctly: only failure to create the
   * process proves the command never reached its target.
   */
  readonly spawnError?: ((cause: unknown) => Error) | undefined;
}

/** Runs argv to completion and collects its output under the shared cancellation contract. */
export async function runArgv(argv: readonly string[], options: RunArgvOptions = {}): Promise<CommandResult> {
  const { signal } = options;
  signal?.throwIfAborted();
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn([...argv], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    throw options.spawnError ? options.spawnError(error) : error;
  }

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      readText(proc.stdout, options.stdoutLimit),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    signal?.throwIfAborted();
    return { stdout, stderr, exitCode };
  } catch (error) {
    // Abort wins over whatever stream or exit failure the kill produced.
    signal?.throwIfAborted();
    throw error;
  } finally {
    // An output-limit failure leaves the child running; reap it before returning.
    if (proc.exitCode === null && proc.signalCode === null) proc.kill();
    await proc.exited;
  }
}

/** Default `CommandRunner` for callers that need no spawn-error mapping or output cap. */
export const runCommand: CommandRunner = (argv, signal) => runArgv(argv, { signal });

async function readText(stream: ReadableStream<Uint8Array>, limit: OutputLimit | undefined): Promise<string> {
  if (limit === undefined) return await new Response(stream).text();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of stream) {
    bytes += chunk.byteLength;
    if (bytes > limit.bytes) throw limit.error();
    chunks.push(chunk);
  }
  return await new Response(Buffer.concat(chunks, bytes)).text();
}
