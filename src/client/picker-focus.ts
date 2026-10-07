import { createConnection, type Socket } from "node:net";

import { readPickerSnapshot } from "./picker-snapshot.ts";

import {
  parsePickerFocusLifecycleMessage,
  type PickerFocusLifecycleMessage,
  type PickerFocusRequestIds,
} from "./types.ts";

const REQUEST_IDS: PickerFocusRequestIds = {
  subscribe: "herdr-pickers:focus-subscribe",
  snapshot: "herdr-pickers:focus-snapshot",
};
const REQUEST_METHODS = {
  subscribe: "events.subscribe",
} as const;
const FOCUS_SUBSCRIPTIONS = [
  { type: "pane.focused" },
  { type: "tab.focused" },
  { type: "workspace.focused" },
] as const;
const MAX_MESSAGE_BUFFER_BYTES = 64 * 1024;
const SETUP_TIMEOUT_MS = 1_000;
const NEWLINE_BYTE = 0x0a;
const SETUP_FAILURE_MESSAGE = "Failed to establish picker focus observation";
const WATCH_FAILURE_MESSAGE = "Picker focus observation failed";
const FOCUS_DEPARTURE_MESSAGE = "Focus left the picker";

export class PickerFocusDeparture extends Error {
  constructor() { super(FOCUS_DEPARTURE_MESSAGE); }
}

type FocusEvent = Exclude<PickerFocusLifecycleMessage,
  { readonly kind: "subscription-started" } | { readonly kind: "snapshot" }>;
type Stage = "connecting" | "subscription" | "snapshot" | "active" | "stopped" | "failed";

interface FocusOwner {
  readonly paneId: string;
  readonly tabId: string;
  readonly workspaceId: string;
}

export async function watchPickerFocus(
  socketPath: string,
  paneId: string,
  signal?: AbortSignal,
): Promise<{ signal: AbortSignal; stop(): void; prepareDispatch(): Promise<void> }> {
  signal?.throwIfAborted();
  const controller = new AbortController();
  const snapshots = new AbortController();
  const socket = createConnection(socketPath);
  socket.unref();

  return await new Promise((resolve, reject) => {
    let stage: Stage = "connecting";
    const buffers = new Map<Socket, Buffer>();
    let dispatchTimer: ReturnType<typeof setTimeout> | undefined;
    let owner: FocusOwner | undefined;
    let dispatch: { resolve(): void; reject(error: Error): void } | undefined;
    let ready = false;
    let dirty = false;
    let setupTimer = setTimeout(() => terminate(), SETUP_TIMEOUT_MS);

    const watcher = {
      signal: controller.signal,
      prepareDispatch(): Promise<void> {
        if (!ready || stage === "stopped" || stage === "failed" || dispatch) return Promise.reject(new Error(WATCH_FAILURE_MESSAGE));
        return new Promise((resolve, reject) => {
          dispatch = { resolve, reject };
          dispatchTimer = setTimeout(terminate, SETUP_TIMEOUT_MS);
          if (stage === "snapshot") dirty = true;
          else requestSnapshot();
        });
      },
      stop() {
        if (!ready || stage === "stopped" || stage === "failed") return;
        stage = "stopped";
        dispatch?.reject(new Error(WATCH_FAILURE_MESSAGE));
        dispatch = undefined;
        cleanup();
      },
    };

    function terminate(): void {
      finish(new Error(ready ? WATCH_FAILURE_MESSAGE : SETUP_FAILURE_MESSAGE));
    }

    function finish(error: Error): void {
      if (stage === "stopped" || stage === "failed") return;
      const wasActive = ready;
      stage = "failed";
      controller.abort(error);
      dispatch?.reject(error);
      dispatch = undefined;
      cleanup();
      if (!wasActive) reject(error);
    }

    function cleanup(): void {
      dispose(socket, setupTimer);
      clearTimeout(dispatchTimer);
      signal?.removeEventListener("abort", terminate);
      snapshots.abort();
      buffers.clear();
    }

    function writeRequest(connection: Socket, payload: unknown): void {
      connection.write(`${JSON.stringify(payload)}\n`);
    }

    function requestSnapshot(): void {
      stage = "snapshot";
      dirty = false;
      clearTimeout(setupTimer);
      setupTimer = setTimeout(terminate, SETUP_TIMEOUT_MS);
      void readPickerSnapshot(socketPath, paneId, snapshots.signal)
        .then(message => { if (stage === "snapshot") handleMessage(message); })
        .catch(terminate);
    }

    function handleMessage(message: PickerFocusLifecycleMessage): void {
      if (message.kind === "subscription-started") {
        if (stage !== "subscription") return terminate();
        requestSnapshot();
        return;
      }

      if (message.kind === "snapshot") {
        if (stage !== "snapshot" || message.paneId !== paneId) return terminate();
        if (!message.globallyFocused) return finish(new PickerFocusDeparture());
        const resolvedOwner = { paneId: message.paneId, tabId: message.tabId, workspaceId: message.workspaceId };
        owner = resolvedOwner;
        stage = "active";
        clearTimeout(setupTimer);
        ready = true;
        resolve(watcher);
        if (dirty) requestSnapshot();
        else if (dispatch) {
          const accepted = dispatch;
          dispatch = undefined;
          watcher.stop();
          accepted.resolve();
        }
        return;
      }

      if (stage === "snapshot") {
        if (!owner || focusDeparted(message, owner)) dirty = true;
        return;
      }

      if (stage !== "active" || !owner) return terminate();
      // Herdr replays old focus events, so only current focus can prove departure.
      if (focusDeparted(message, owner)) requestSnapshot();
    }

    function handleData(connection: Socket, chunk: Buffer): void {
      const budget = MAX_MESSAGE_BUFFER_BYTES;
      let buffer = Buffer.concat([buffers.get(connection) ?? Buffer.alloc(0), chunk]);
      let newline = buffer.indexOf(NEWLINE_BYTE);
      while (newline >= 0) {
        if (newline > budget) return terminate();
        const raw = buffer.subarray(0, newline).toString("utf8");
        buffer = buffer.subarray(newline + 1);
        try {
          handleMessage(parsePickerFocusLifecycleMessage(raw, REQUEST_IDS, paneId));
        } catch {
          terminate();
        }
        if (stage === "stopped" || stage === "failed") return;
        newline = buffer.indexOf(NEWLINE_BYTE);
      }
      if (buffer.length > budget) return terminate();
      if (!connection.destroyed) buffers.set(connection, buffer);
    }

    signal?.addEventListener("abort", terminate, { once: true });
    socket.once("connect", () => {
      if (stage !== "connecting") return;
      stage = "subscription";
      writeRequest(socket, {
        id: REQUEST_IDS.subscribe,
        method: REQUEST_METHODS.subscribe,
        params: { subscriptions: FOCUS_SUBSCRIPTIONS },
      });
    });
    socket.on("data", (chunk: Buffer) => handleData(socket, chunk));
    socket.once("error", terminate);
    socket.once("end", terminate);
    socket.once("close", terminate);
  });
}

function focusDeparted(event: FocusEvent, owner: FocusOwner): boolean {
  switch (event.kind) {
    case "pane-focused":
      return event.paneId !== owner.paneId || event.workspaceId !== owner.workspaceId;
    case "tab-focused":
      return event.tabId !== owner.tabId || event.workspaceId !== owner.workspaceId;
    case "workspace-focused":
      return event.workspaceId !== owner.workspaceId;
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

function dispose(socket: Socket, setupTimer: ReturnType<typeof setTimeout>): void {
  clearTimeout(setupTimer);
  socket.removeAllListeners();
  socket.destroy();
}

const SOCKET_REQUIRED_MESSAGE = "HERDR_SOCKET_PATH is required to observe overlay picker focus.";

/** Where a guard observes focus; a popup has no pane of its own to watch. */
export interface PickerFocusTarget {
  readonly socketPath: string | undefined;
  readonly paneId: string | undefined;
}

/**
 * One mode's focus contract: focus departure cancels the picker, and dispatch
 * proceeds only after Herdr reconfirms the picker still holds focus.
 */
export interface PickerFocusGuard {
  checkBeforeDispatch(): Promise<void>;
  dispose(): Promise<void>;
  /** Observer breakage, as opposed to departure, which is ordinary cancellation. */
  readonly failure: { readonly error: unknown } | undefined;
}

/**
 * Builds a fresh guard per mode because accepting a selection stops its
 * observer. `onLost` aborts the picker; only losses while the mode is live count.
 */
export function createPickerFocusGuard(
  target: PickerFocusTarget,
  signal: AbortSignal,
  onLost: (reason: unknown) => void,
): PickerFocusGuard {
  const { socketPath, paneId } = target;
  let watch: Awaited<ReturnType<typeof watchPickerFocus>> | undefined;
  let failure: { readonly error: unknown } | undefined;
  const lose = (error: unknown): void => {
    if (signal.aborted) return;
    if (!(error instanceof PickerFocusDeparture)) failure = { error };
    onLost(error);
  };
  const ready = paneId === undefined
    ? undefined
    : (socketPath === undefined
      ? Promise.reject(new Error(SOCKET_REQUIRED_MESSAGE))
      : watchPickerFocus(socketPath, paneId, signal)
    ).then(watcher => {
      watch = watcher;
      watcher.signal.addEventListener("abort", () => lose(watcher.signal.reason), { once: true });
      if (watcher.signal.aborted) lose(watcher.signal.reason);
    }).catch(lose);
  return {
    get failure() { return failure; },
    async checkBeforeDispatch() {
      await ready;
      signal.throwIfAborted();
      await watch?.prepareDispatch();
    },
    async dispose() {
      // Stop an established observer immediately; setup still in flight settles
      // on the aborted mode signal and may yield a watcher that needs stopping too.
      watch?.stop();
      await ready;
      watch?.stop();
    },
  };
}
