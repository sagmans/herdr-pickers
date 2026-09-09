import {
  systemTerminal, TERMINAL_START, TERMINAL_STOP,
  type TerminalAdapter, type TerminalPickerOptions,
} from "./terminal-picker.ts";

type Input = string | Uint8Array;

export class PickerTerminal {
  private readonly input: AsyncIterator<Input>;
  private pending: Promise<{ result: IteratorResult<Input>; generation: number }> | undefined;
  private generation = 0;
  private started = false;
  private readonly inputState = { remainder: "" };

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
            const pending = this.pending ??= this.input.next().then(result => ({ result, generation: this.generation }));
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

  close(): void {
    if (!this.started) return;
    this.started = false;
    this.generation++;
    try { this.terminal.write(TERMINAL_STOP); } catch {}
    try { this.terminal.setRawMode(false); } catch {}
    try { void this.input.return?.(); } catch {}
  }
}
