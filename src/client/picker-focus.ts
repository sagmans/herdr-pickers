import { createConnection, type Socket } from "node:net";

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
  snapshot: "session.snapshot",
} as const;
const FOCUS_SUBSCRIPTIONS = [
  { type: "pane.focused" },
  { type: "tab.focused" },
  { type: "workspace.focused" },
] as const;
const MAX_MESSAGE_BUFFER_BYTES = 64 * 1024;
// Session snapshots include every pane and its metadata, unlike individual focus events.
const MAX_SNAPSHOT_BUFFER_BYTES = 1024 * 1024;
const SETUP_TIMEOUT_MS = 1_000;
const NEWLINE_BYTE = 0x0a;
const SETUP_FAILURE_MESSAGE = "Failed to establish picker focus observation";
const WATCH_FAILURE_MESSAGE = "Picker focus observation failed";

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
): Promise<{ signal: AbortSignal; stop(): void; prepareDispatch(): Promise<void> }> {
  const controller = new AbortController();
  const socket = createConnection(socketPath);
  socket.unref();

  return await new Promise((resolve, reject) => {
    let stage: Stage = "connecting";
    const buffers = new Map<Socket, Buffer>();
    let snapshotSocket: Socket | undefined;
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
      if (stage === "stopped" || stage === "failed") return;
      const wasActive = ready;
      stage = "failed";
      const error = new Error(wasActive ? WATCH_FAILURE_MESSAGE : SETUP_FAILURE_MESSAGE);
      controller.abort(error);
      dispatch?.reject(error);
      dispatch = undefined;
      cleanup();
      if (!wasActive) reject(error);
    }

    function cleanup(): void {
      dispose(socket, setupTimer);
      if (snapshotSocket) dispose(snapshotSocket, setupTimer);
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
      // Herdr accepts only one request per connection, including subscription streams.
      const connection = createConnection(socketPath);
      snapshotSocket = connection;
      connection.unref();
      connection.once("connect", () => {
        writeRequest(connection, { id: REQUEST_IDS.snapshot, method: REQUEST_METHODS.snapshot, params: {} });
      });
      connection.on("data", (chunk: Buffer) => handleData(connection, chunk));
      connection.once("error", terminate);
      connection.once("end", () => { if (stage === "snapshot") terminate(); });
      connection.once("close", () => { if (stage === "snapshot") terminate(); });
    }

    function handleMessage(message: PickerFocusLifecycleMessage): void {
      if (message.kind === "subscription-started") {
        if (stage !== "subscription") return terminate();
        requestSnapshot();
        return;
      }

      if (message.kind === "snapshot") {
        if (stage !== "snapshot" || !message.globallyFocused || message.paneId !== paneId) return terminate();
        const resolvedOwner = { paneId: message.paneId, tabId: message.tabId, workspaceId: message.workspaceId };
        owner = resolvedOwner;
        stage = "active";
        if (snapshotSocket) {
          buffers.delete(snapshotSocket);
          dispose(snapshotSocket, setupTimer);
        }
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
      const budget = connection === socket ? MAX_MESSAGE_BUFFER_BYTES : MAX_SNAPSHOT_BUFFER_BYTES;
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
