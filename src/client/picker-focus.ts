// Overlay focus observation over Herdr's native event socket. Overlay pickers
// must cancel when focus leaves them and must reconfirm focus before dispatch;
// popups need none of this. Wire messages are parsed in ./types.ts.
import { createConnection, type Socket } from "node:net";

import { readPickerSnapshot } from "./picker-snapshot.ts";

import { parsePickerFocusLifecycleMessage, type PickerFocusLifecycleMessage } from "./types.ts";

// Snapshots travel over their own native-client connection, so the
// subscription socket only ever answers this one request.
const SUBSCRIBE_REQUEST_ID = "herdr-pickers:focus-subscribe";
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

/** Focus left the picker: ordinary cancellation, distinct from observer failure. */
export class PickerFocusDeparture extends Error {
  constructor() { super(FOCUS_DEPARTURE_MESSAGE); }
}

type FocusEvent = Exclude<PickerFocusLifecycleMessage,
  { readonly kind: "subscription-started" } | { readonly kind: "snapshot" }>;

interface FocusOwner {
  readonly paneId: string;
  readonly tabId: string;
  readonly workspaceId: string;
}

/** A caller waiting for focus to be reconfirmed before it dispatches. */
interface PendingDispatch {
  resolve(): void;
  reject(error: Error): void;
}

/**
 * Observer lifecycle. `confirming` waits for the first snapshot to prove focus;
 * `reverifying` re-proves it after a departure or during dispatch. `stale` marks
 * a snapshot that focus events may already have outdated.
 */
type FocusStage =
  | { readonly kind: "connecting" }
  | { readonly kind: "subscribing" }
  | { readonly kind: "confirming"; readonly stale: boolean }
  | {
    readonly kind: "reverifying";
    readonly owner: FocusOwner;
    readonly stale: boolean;
    readonly dispatch: PendingDispatch | undefined;
  }
  | { readonly kind: "watching"; readonly owner: FocusOwner }
  | { readonly kind: "stopped" }
  | { readonly kind: "failed" };

/** Side effects the driver performs after a transition. */
type FocusEffect =
  | { readonly kind: "none" }
  | { readonly kind: "terminate" }
  | { readonly kind: "depart" }
  | { readonly kind: "request-snapshot" }
  | { readonly kind: "established"; readonly reverify: boolean }
  | { readonly kind: "confirm-dispatch"; readonly dispatch: PendingDispatch };

interface FocusStep {
  readonly stage: FocusStage;
  readonly effect: FocusEffect;
}

const NO_EFFECT: FocusEffect = { kind: "none" };
const TERMINATE: FocusEffect = { kind: "terminate" };

/** Pure protocol transition for one Herdr message; the driver owns sockets and timers. */
function advanceFocus(stage: FocusStage, message: PickerFocusLifecycleMessage, paneId: string): FocusStep {
  switch (message.kind) {
    case "subscription-started":
      if (stage.kind !== "subscribing") return { stage, effect: TERMINATE };
      return { stage: confirming(), effect: { kind: "request-snapshot" } };
    case "snapshot": {
      if (!awaitingSnapshot(stage) || message.paneId !== paneId) return { stage, effect: TERMINATE };
      if (!message.globallyFocused) return { stage, effect: { kind: "depart" } };
      const owner = { paneId: message.paneId, tabId: message.tabId, workspaceId: message.workspaceId };
      // Focus moved while this snapshot was in flight; only a fresh one can confirm it.
      if (stage.stale) return { stage: reverifying(owner, pendingDispatch(stage)), effect: { kind: "established", reverify: true } };
      const dispatch = pendingDispatch(stage);
      if (dispatch) return { stage: { kind: "stopped" }, effect: { kind: "confirm-dispatch", dispatch } };
      return { stage: { kind: "watching", owner }, effect: { kind: "established", reverify: false } };
    }
    case "pane-focused":
    case "tab-focused":
    case "workspace-focused":
      return advanceOnFocusEvent(stage, message);
    default: {
      const exhaustive: never = message;
      return exhaustive;
    }
  }
}

function advanceOnFocusEvent(stage: FocusStage, event: FocusEvent): FocusStep {
  switch (stage.kind) {
    case "confirming":
      // Focus is not confirmed yet, so any event may have moved it elsewhere.
      return { stage: { ...stage, stale: true }, effect: NO_EFFECT };
    case "reverifying":
      return focusDeparted(event, stage.owner)
        ? { stage: { ...stage, stale: true }, effect: NO_EFFECT }
        : { stage, effect: NO_EFFECT };
    case "watching":
      // Herdr replays old focus events, so only current focus can prove departure.
      return focusDeparted(event, stage.owner)
        ? { stage: reverifying(stage.owner, undefined), effect: { kind: "request-snapshot" } }
        : { stage, effect: NO_EFFECT };
    case "connecting":
    case "subscribing":
      return { stage, effect: TERMINATE };
    case "stopped":
    case "failed":
      return { stage, effect: NO_EFFECT };
    default: {
      const exhaustive: never = stage;
      return exhaustive;
    }
  }
}

/** Dispatch confirmation: watching starts a fresh snapshot; an in-flight one is marked stale. */
function advanceOnDispatch(stage: FocusStage, dispatch: PendingDispatch): FocusStep | undefined {
  switch (stage.kind) {
    case "watching":
      return { stage: reverifying(stage.owner, dispatch), effect: { kind: "request-snapshot" } };
    case "reverifying":
      return stage.dispatch ? undefined : { stage: { ...stage, stale: true, dispatch }, effect: NO_EFFECT };
    case "confirming":
    case "connecting":
    case "subscribing":
    case "stopped":
    case "failed":
      return undefined;
    default: {
      const exhaustive: never = stage;
      return exhaustive;
    }
  }
}

function confirming(): FocusStage {
  return { kind: "confirming", stale: false };
}

function reverifying(owner: FocusOwner, dispatch: PendingDispatch | undefined): FocusStage {
  return { kind: "reverifying", owner, stale: false, dispatch };
}

/** True once a snapshot has confirmed focus, i.e. setup has resolved. */
function established(stage: FocusStage): boolean {
  return stage.kind === "reverifying" || stage.kind === "watching";
}

/** A snapshot is in flight exactly while a stage is waiting to be re-proven. */
function awaitingSnapshot(stage: FocusStage): stage is Extract<FocusStage, { readonly kind: "confirming" | "reverifying" }> {
  return stage.kind === "confirming" || stage.kind === "reverifying";
}

function pendingDispatch(stage: FocusStage): PendingDispatch | undefined {
  return stage.kind === "reverifying" ? stage.dispatch : undefined;
}

function finished(stage: FocusStage): boolean {
  return stage.kind === "stopped" || stage.kind === "failed";
}

/**
 * Resolves once a snapshot confirms the pane holds focus; rejects if setup fails
 * or times out. Afterwards the returned signal aborts on departure or breakage.
 */
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
    let stage: FocusStage = { kind: "connecting" };
    // Partial newline-delimited message carried between socket chunks.
    let pending = Buffer.alloc(0);
    // Bounds each setup step or snapshot; restarted for every snapshot request.
    let stepTimer = setTimeout(() => terminate(), SETUP_TIMEOUT_MS);
    // Bounds the whole dispatch confirmation so replayed events cannot extend it forever.
    let dispatchTimer: ReturnType<typeof setTimeout> | undefined;

    const watcher = {
      signal: controller.signal,
      prepareDispatch(): Promise<void> {
        return new Promise((resolveDispatch, rejectDispatch) => {
          const step = advanceOnDispatch(stage, { resolve: resolveDispatch, reject: rejectDispatch });
          if (!step) return rejectDispatch(new Error(WATCH_FAILURE_MESSAGE));
          dispatchTimer = setTimeout(terminate, SETUP_TIMEOUT_MS);
          apply(step);
        });
      },
      stop() {
        if (!established(stage)) return;
        const dispatch = pendingDispatch(stage);
        stage = { kind: "stopped" };
        dispatch?.reject(new Error(WATCH_FAILURE_MESSAGE));
        cleanup();
      },
    };

    function terminate(): void {
      finish(new Error(established(stage) ? WATCH_FAILURE_MESSAGE : SETUP_FAILURE_MESSAGE));
    }

    function finish(error: Error): void {
      if (finished(stage)) return;
      const wasEstablished = established(stage);
      const dispatch = pendingDispatch(stage);
      stage = { kind: "failed" };
      controller.abort(error);
      dispatch?.reject(error);
      cleanup();
      if (!wasEstablished) reject(error);
    }

    function cleanup(): void {
      dispose(socket, stepTimer);
      clearTimeout(dispatchTimer);
      signal?.removeEventListener("abort", terminate);
      snapshots.abort();
      pending = Buffer.alloc(0);
    }

    function writeRequest(connection: Socket, payload: unknown): void {
      connection.write(`${JSON.stringify(payload)}\n`);
    }

    function requestSnapshot(): void {
      clearTimeout(stepTimer);
      stepTimer = setTimeout(terminate, SETUP_TIMEOUT_MS);
      void readPickerSnapshot(socketPath, paneId, snapshots.signal)
        .then(message => { if (awaitingSnapshot(stage)) handleMessage(message); })
        .catch(terminate);
    }

    function apply(step: FocusStep): void {
      const { effect } = step;
      switch (effect.kind) {
        case "none":
          stage = step.stage;
          return;
        case "terminate":
          return terminate();
        case "depart":
          return finish(new PickerFocusDeparture());
        case "request-snapshot":
          stage = step.stage;
          return requestSnapshot();
        case "established":
          stage = step.stage;
          clearTimeout(stepTimer);
          resolve(watcher);
          if (effect.reverify) requestSnapshot();
          return;
        case "confirm-dispatch":
          // Stop before resolving so no late event can abort an accepted dispatch.
          stage = step.stage;
          cleanup();
          effect.dispatch.resolve();
          return;
        default: {
          const exhaustive: never = effect;
          return exhaustive;
        }
      }
    }

    function handleMessage(message: PickerFocusLifecycleMessage): void {
      apply(advanceFocus(stage, message, paneId));
    }

    function handleData(chunk: Buffer): void {
      const budget = MAX_MESSAGE_BUFFER_BYTES;
      let buffer = Buffer.concat([pending, chunk]);
      let newline = buffer.indexOf(NEWLINE_BYTE);
      while (newline >= 0) {
        if (newline > budget) return terminate();
        const raw = buffer.subarray(0, newline).toString("utf8");
        buffer = buffer.subarray(newline + 1);
        try {
          handleMessage(parsePickerFocusLifecycleMessage(raw, SUBSCRIBE_REQUEST_ID));
        } catch {
          terminate();
        }
        if (finished(stage)) return;
        newline = buffer.indexOf(NEWLINE_BYTE);
      }
      if (buffer.length > budget) return terminate();
      if (!socket.destroyed) pending = buffer;
    }

    signal?.addEventListener("abort", terminate, { once: true });
    socket.once("connect", () => {
      if (stage.kind !== "connecting") return;
      stage = { kind: "subscribing" };
      writeRequest(socket, {
        id: SUBSCRIBE_REQUEST_ID,
        method: REQUEST_METHODS.subscribe,
        params: { subscriptions: FOCUS_SUBSCRIPTIONS },
      });
    });
    socket.on("data", handleData);
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

function dispose(socket: Socket, stepTimer: ReturnType<typeof setTimeout>): void {
  clearTimeout(stepTimer);
  socket.removeAllListeners();
  socket.destroy();
}
