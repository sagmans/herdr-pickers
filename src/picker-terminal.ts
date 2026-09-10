import {
  systemTerminal, TERMINAL_START, TERMINAL_STOP,
  type TerminalAdapter, type TerminalPickerOptions,
} from "./terminal-picker.ts";

type Input = string | Uint8Array;
const UTF8_LEAD_MIN = 0xc2;
const UTF8_LEAD_MAX = 0xf4;
const ENCODER = new TextEncoder();

export class PickerTerminal {
  private readonly input: AsyncIterator<Input>;
  private pending: Promise<{ result: IteratorResult<Input>; generation: number }> | undefined;
  private generation = 0;
  private started = false;
  private readonly inputState = { remainder: "" };
  private readonly decoder = new TextDecoder();
  private decodingGeneration: number | undefined;

  constructor(private readonly terminal: TerminalAdapter = systemTerminal()) {
    this.input = terminal.input[Symbol.asyncIterator]();
  }

  options(signal?: AbortSignal): Pick<TerminalPickerOptions, "terminal" | "sharedTerminal" | "inputState"> {
    const generation = ++this.generation;
    if (!this.started) {
      this.terminal.setRawMode(true);
      this.started = true;
      this.terminal.write(TERMINAL_START);
    }
    const input: AsyncIterable<Input> = {
      [Symbol.asyncIterator]: () => ({
        next: async () => {
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
        return: async () => ({ done: true, value: undefined }),
      }),
    };
    return {
      sharedTerminal: true,
      inputState: this.inputState,
      terminal: {
        input,
        write: value => this.terminal.write(value),
        setRawMode: value => this.terminal.setRawMode(value),
        getViewport: () => this.terminal.getViewport(),
        onResize: listener => this.terminal.onResize(listener),
      },
    };
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

  close(): void {
    if (!this.started) return;
    this.started = false;
    this.generation++;
    try { this.terminal.write(TERMINAL_STOP); } catch {}
    try { this.terminal.setRawMode(false); } catch {}
    try { void this.input.return?.(); } catch {}
  }
}
