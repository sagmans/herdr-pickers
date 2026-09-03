import type {
  PickerTimers,
  TerminalAdapter,
  Viewport,
} from "../src/terminal-picker.ts";

export const VIEWPORT: Viewport = { columns: 24, rows: 6 };
export const TALL_VIEWPORT: Viewport = { columns: 24, rows: 8 };

export class FakeTerminal implements TerminalAdapter {
  readonly writes: string[] = [];
  readonly rawModes: boolean[] = [];
  readonly input: AsyncIterable<string | Uint8Array>;
  private resizeListener: (() => void) | undefined;
  private finishInput: (() => void) | undefined;

  constructor(
    chunks: readonly (string | Uint8Array | Promise<string | Uint8Array>)[],
    private viewport: Viewport = VIEWPORT,
    hangAfterInput = false,
    private failStopWrite = false,
  ) {
    let finishInput: (() => void) | undefined;
    this.input = (async function* () {
      for (const chunk of chunks) yield await chunk;
      if (hangAfterInput) await new Promise<void>((resolve) => {
        finishInput = resolve;
      });
    })();
    this.finishInput = () => finishInput?.();
  }

  write(value: string): void {
    this.writes.push(value);
    if (this.failStopWrite && value.includes("\x1b[?1049l")) throw new Error("stop write failed");
  }

  setRawMode(enabled: boolean): void {
    this.rawModes.push(enabled);
  }

  getViewport(): Viewport {
    return this.viewport;
  }

  onResize(listener: () => void): () => void {
    this.resizeListener = listener;
    return () => {
      this.resizeListener = undefined;
    };
  }

  finish(): void {
    this.finishInput?.();
  }
}

export class FakeTimers implements PickerTimers {
  private readonly intervals: Array<{ readonly callback: () => void; readonly milliseconds: number; active: boolean }> = [];

  readonly setInterval = (callback: () => void, milliseconds: number): unknown => {
    const interval = { callback, milliseconds, active: true };
    this.intervals.push(interval);
    return interval;
  };

  readonly clearInterval = (handle: unknown): void => {
    const interval = handle as { active?: boolean };
    interval.active = false;
  };

  fire(milliseconds: number): void {
    for (const interval of this.intervals) {
      if (interval.active && interval.milliseconds === milliseconds) interval.callback();
    }
  }

  activeCount(): number {
    return this.intervals.filter((interval) => interval.active).length;
  }
}
