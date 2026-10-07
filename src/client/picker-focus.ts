import { createConnection, type Socket } from "node:net";

import type { PickerSurface } from "./popup.ts";
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
 * Observer lifecycle. `owner` is known once the first snapshot confirms focus;
 * `stale` marks a verifying snapshot that focus events may already have outdated.
 */
type FocusStage =
  | { readonly kind: "connecting" }
  | { readonly kind: "subscribing" }
  | {
    readonly kind: "verifying";
    readonly owner: FocusOwner | undefined;
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
      return { stage: verifying(undefined, undefined), effect: { kind: "request-snapshot" } };
    case "snapshot": {
      if (stage.kind !== "verifying" || message.paneId !== paneId) return { stage, effect: TERMINATE };
      if (!message.globallyFocused) return { stage, effect: { kind: "depart" } };
      const owner = { paneId: message.paneId, tabId: message.tabId, workspaceId: message.workspaceId };
      // Focus moved while this snapshot was in flight; only a fresh one can confirm it.
      if (stage.stale) return { stage: verifying(owner, stage.dispatch), effect: { kind: "established", reverify: true } };
      if (stage.dispatch) return { stage: { kind: "stopped" }, effect: { kind: "confirm-dispatch", dispatch: stage.dispatch } };
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
    case "verifying":
      return !stage.owner || focusDeparted(event, stage.owner)
        ? { stage: { ...stage, stale: true }, effect: NO_EFFECT }
        : { stage, effect: NO_EFFECT };
    case "watching":
      // Herdr replays old focus events, so only current focus can prove departure.
      return focusDeparted(event, stage.owner)
        ? { stage: verifying(stage.owner, undefined), effect: { kind: "request-snapshot" } }
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
      return { stage: verifying(stage.owner, dispatch), effect: { kind: "request-snapshot" } };
    case "verifying":
      return stage.owner && !stage.dispatch ? { stage: { ...stage, stale: true, dispatch }, effect: NO_EFFECT } : undefined;
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

function verifying(owner: FocusOwner | undefined, dispatch: PendingDispatch | undefined): FocusStage {
  return { kind: "verifying", owner, stale: false, dispatch };
}

/** True once a snapshot has confirmed focus, i.e. setup has resolved. */
function established(stage: FocusStage): boolean {
  return (stage.kind === "verifying" && stage.owner !== undefined) || stage.kind === "watching";
}

function pendingDispatch(stage: FocusStage): PendingDispatch | undefined {
  return stage.kind === "verifying" ? stage.dispatch : undefined;
}

function finished(stage: FocusStage): boolean {
  return stage.kind === "stopped" || stage.kind === "failed";
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
          const step = established(stage) ? advanceOnDispatch(stage, { resolve: resolveDispatch, reject: rejectDispatch }) : undefined;
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
        .then(message => { if (stage.kind === "verifying") handleMessage(message); })
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

const SOCKET_REQUIRED_MESSAGE = "HERDR_SOCKET_PATH is required to observe overlay picker focus.";

/** Where a guard observes focus; a popup has no pane of its own to watch. */
export interface PickerFocusTarget {
  readonly socketPath: string | undefined;
  readonly surface: PickerSurface;
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
  const { socketPath, surface } = target;
  let watch: Awaited<ReturnType<typeof watchPickerFocus>> | undefined;
  let failure: { readonly error: unknown } | undefined;
  const lose = (error: unknown): void => {
    if (signal.aborted) return;
    if (!(error instanceof PickerFocusDeparture)) failure = { error };
    onLost(error);
  };
  const ready = surface.placement === "popup"
    ? undefined
    : (socketPath === undefined
      ? Promise.reject(new Error(SOCKET_REQUIRED_MESSAGE))
      : watchPickerFocus(socketPath, surface.paneId, signal)
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
