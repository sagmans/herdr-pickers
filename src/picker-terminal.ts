import type { Viewport } from "./terminal-picker-view.ts";

type Input = string | Uint8Array;
const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;
const UTF8_LEAD_MIN = 0xc2;
const UTF8_LEAD_MAX = 0xf4;
const ENCODER = new TextEncoder();
const TTY_REQUIRED_MESSAGE = "Agent picker requires a TTY.";
const ALTERNATE_SCREEN_ENTER = "\x1b[?1049h";
const ALTERNATE_SCREEN_EXIT = "\x1b[?1049l";
const MOUSE_TRACKING_ENABLE = "\x1b[?1000h";
const MOUSE_TRACKING_DISABLE = "\x1b[?1000l";
const SGR_MOUSE_ENABLE = "\x1b[?1006h";
const SGR_MOUSE_DISABLE = "\x1b[?1006l";
const LINE_WRAP_DISABLE = "\x1b[?7l";
const LINE_WRAP_ENABLE = "\x1b[?7h";
/** Shared with frame drawing so the restore sequence and every frame agree on cursor visibility. */
export const CURSOR_SHOW = "\x1b[?25h";
export const TERMINAL_START = `${ALTERNATE_SCREEN_ENTER}${LINE_WRAP_DISABLE}${MOUSE_TRACKING_ENABLE}${SGR_MOUSE_ENABLE}`;
export const TERMINAL_STOP = `${SGR_MOUSE_DISABLE}${MOUSE_TRACKING_DISABLE}${LINE_WRAP_ENABLE}${CURSOR_SHOW}${ALTERNATE_SCREEN_EXIT}`;

/** Raw device seam: production binds process stdio, tests bind a fake. */
export interface TerminalAdapter {
  readonly input: AsyncIterable<Input>;
  write(value: string): void;
  setRawMode(enabled: boolean): void;
  getViewport(): Viewport;
  onResize(listener: () => void): () => void;
}

/**
 * One picker mode's view of the shared terminal. Input arrives already decoded,
 * and the unparsed remainder survives mode replacement so split keys never leak.
 */
export interface TerminalLease {
  readonly input: AsyncIterable<string>;
  readonly inputState: { remainder: string };
  write(value: string): void;
  getViewport(): Viewport;
  onResize(listener: () => void): () => void;
}

/**
 * Sole owner of the terminal device for a picker process: raw mode, screen
 * modes, UTF-8 framing, and the single pending stdin read. Modes borrow it via
 * leases so replacement never flashes the primary screen or drops input.
 */
export class PickerTerminal {
  private readonly input: AsyncIterator<Input>;
  private pending: Promise<{ result: IteratorResult<string>; generation: number }> | undefined;
  private generation = 0;
  private state: "idle" | "started" | "closed" = "idle";
  private readonly inputState = { remainder: "" };
  private readonly decoder = new TextDecoder();
  private decodingGeneration: number | undefined;

  constructor(private readonly terminal: TerminalAdapter = systemTerminal()) {
    this.input = terminal.input[Symbol.asyncIterator]();
  }

  /** Hands the terminal to a new mode; any reader from the previous lease is retired. */
  lease(signal?: AbortSignal): TerminalLease {
    const generation = ++this.generation;
    const input: AsyncIterable<string> = {
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          this.start();
          while (true) {
            const pending = this.pending ??= this.input.next().then(result => ({
              result: result.done ? result : { done: false as const, value: this.decode(result.value) },
              generation: this.generation,
            }));
            const chunk = await pending;
            // An abandoned waiter cannot consume input intended for the new mode.
            if (signal?.aborted || generation !== this.generation) return { done: true, value: undefined };
            this.pending = undefined;
            if (chunk.generation === generation) return chunk.result;
          }
        },
        // The device iterator outlives each mode; only close() may end it.
        return: async () => ({ done: true, value: undefined }),
      }),
    };
    return {
      input,
      inputState: this.inputState,
      write: value => {
        // Deferred until first output so a mode cancelled before drawing never touches the device.
        this.start();
        this.terminal.write(value);
      },
      getViewport: () => this.terminal.getViewport(),
      onResize: listener => this.terminal.onResize(listener),
    };
  }

  /** Restores every terminal mode; safe to call on any exit path, including failures. */
  close(): void {
    if (this.state !== "started") {
      this.state = "closed";
      return;
    }
    this.state = "closed";
    this.generation++;
    try { this.terminal.write(TERMINAL_STOP); } catch {}
    try { this.terminal.setRawMode(false); } catch {}
    try { void this.input.return?.(); } catch {}
  }

  private start(): void {
    if (this.state !== "idle") return;
    this.terminal.setRawMode(true);
    this.state = "started";
    this.terminal.write(TERMINAL_START);
  }

  private decode(input: Input): string {
    let text = "";
    const bytes = typeof input === "string" ? ENCODER.encode(input) : input;
    for (const byte of bytes) {
      this.decodingGeneration ??= this.generation;
      const decoded = this.decoder.decode(Uint8Array.of(byte), { stream: true });
      // Byte framing preserves fresh text even when it terminates an obsolete invalid character.
      text += this.decodingGeneration === this.generation ? decoded : Array.from(decoded).slice(1).join("");
      if (byte >= UTF8_LEAD_MIN && byte <= UTF8_LEAD_MAX) this.decodingGeneration = this.generation;
      else if (decoded.length > 0) this.decodingGeneration = undefined;
    }
    return text;
  }
}

/**
 * Runs work on one terminal lifetime. Dismissal precedes restoration because
 * restoring first would expose the blank primary screen inside the popup.
 */
export async function withPickerTerminal<T>(
  adapter: TerminalAdapter | undefined,
  work: (terminal: PickerTerminal) => Promise<T>,
  dismiss?: () => Promise<void>,
): Promise<T> {
  const terminal = new PickerTerminal(adapter);
  try {
    return await work(terminal);
  } finally {
    try { await dismiss?.(); } finally { terminal.close(); }
  }
}

export function systemTerminal(): TerminalAdapter {
  return {
    input: process.stdin,
    write: (value) => {
      process.stdout.write(value);
    },
    setRawMode: (enabled) => {
      if (!process.stdin.isTTY) throw new Error(TTY_REQUIRED_MESSAGE);
      process.stdin.setRawMode(enabled);
      if (enabled) {
        process.stdin.resume();
        process.stdin.ref();
      } else {
        process.stdin.pause();
        process.stdin.unref();
      }
    },
    getViewport: () => ({
      columns: process.stdout.columns ?? DEFAULT_COLUMNS,
      rows: process.stdout.rows ?? DEFAULT_ROWS,
    }),
    onResize: (listener) => {
      process.stdout.on("resize", listener);
      return () => process.stdout.off("resize", listener);
    },
  };
}
