import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { watchPickerFocus } from "../src/client/picker-focus.ts";

const PANE_ID = "pane-owner";
const OTHER_PANE_ID = "pane-other";
const TAB_ID = "tab-owner";
const OTHER_TAB_ID = "tab-other";
const WORKSPACE_ID = "workspace-owner";
const OTHER_WORKSPACE_ID = "workspace-other";
const SOCKET_NAME = "s";
const TEMP_PREFIX = "hpf-";
const PROTOCOL_VERSION = 20;
const HERDR_VERSION = "0.8.2";
const AGENT_STATUS = "idle";
const MAX_ABORT_WAIT_MS = 2_000;
const SPLIT_DELAY_MS = 5;
const INPUT_SETTLE_MS = 50;
const OVERSIZED_PAYLOAD_BYTES = 128 * 1024;
const SUBSCRIBE_METHOD = "events.subscribe";
const SNAPSHOT_METHOD = "session.snapshot";
const EXPECTED_SUBSCRIPTIONS = [
  { type: "pane.focused" },
  { type: "tab.focused" },
  { type: "workspace.focused" },
];

interface TestServer {
  readonly path: string;
  readonly requests: Record<string, unknown>[];
  readonly connected: Promise<Socket>;
  close(): Promise<void>;
}

type RequestHandler = (request: Record<string, unknown>, socket: Socket) => void;

function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function snapshotResponse(id: unknown, focusedPaneId = PANE_ID): Record<string, unknown> {
  return {
    id,
    result: {
      type: "session_snapshot",
      snapshot: {
        version: HERDR_VERSION,
        protocol: PROTOCOL_VERSION,
        focused_workspace_id: focusedPaneId === PANE_ID ? WORKSPACE_ID : OTHER_WORKSPACE_ID,
        focused_tab_id: focusedPaneId === PANE_ID ? TAB_ID : OTHER_TAB_ID,
        focused_pane_id: focusedPaneId,
        workspaces: [{
          workspace_id: WORKSPACE_ID,
          number: 1,
          label: "Owner workspace",
          focused: focusedPaneId === PANE_ID,
          pane_count: 1,
          tab_count: 1,
          active_tab_id: TAB_ID,
          agent_status: AGENT_STATUS,
        }],
        tabs: [{
          tab_id: TAB_ID,
          workspace_id: WORKSPACE_ID,
          number: 1,
          label: "Owner tab",
          focused: focusedPaneId === PANE_ID,
          pane_count: 1,
          agent_status: AGENT_STATUS,
        }],
        panes: [{
          pane_id: PANE_ID,
          terminal_id: "terminal-owner",
          workspace_id: WORKSPACE_ID,
          tab_id: TAB_ID,
          focused: focusedPaneId === PANE_ID,
          agent_status: AGENT_STATUS,
          revision: 0,
        }],
        layouts: [],
        agents: [],
      },
    },
  };
}

function focusEvent(event: "pane_focused" | "tab_focused" | "workspace_focused", values: Record<string, unknown>): string {
  return line({ event, data: { type: event, ...values } });
}

async function startServer(onRequest: RequestHandler): Promise<TestServer> {
  const directory = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
  const path = join(directory, SOCKET_NAME);
  const sockets = new Set<Socket>();
  const requests: Record<string, unknown>[] = [];
  let resolveConnected!: (socket: Socket) => void;
  const connected = new Promise<Socket>((resolve) => {
    resolveConnected = resolve;
  });
  const server = createServer((socket) => {
    sockets.add(socket);
    resolveConnected(socket);
    let buffer = "";
    let requested = false;
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const raw = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const request = JSON.parse(raw) as Record<string, unknown>;
        requests.push(request);
        if (!requested) {
          requested = true;
          onRequest(request, socket);
        }
        newline = buffer.indexOf("\n");
      }
    });
    socket.once("close", () => sockets.delete(socket));
  });
  await listen(server, path);

  return {
    path,
    requests,
    connected,
    async close() {
      for (const socket of sockets) socket.destroy();
      await closeServer(server);
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function listen(server: Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function standardHandshake(options: { readonly splitAcknowledgement?: boolean; readonly snapshotSuffix?: string } = {}): RequestHandler {
  let subscription: Socket;
  return (request, socket) => {
    if (request.method === SUBSCRIBE_METHOD) {
      subscription = socket;
      const acknowledgement = line({ id: request.id, result: { type: "subscription_started" } });
      if (options.splitAcknowledgement) {
        const midpoint = Math.floor(acknowledgement.length / 2);
        socket.write(acknowledgement.slice(0, midpoint));
        setTimeout(() => socket.write(acknowledgement.slice(midpoint)), SPLIT_DELAY_MS);
      } else {
        socket.write(acknowledgement);
      }
      return;
    }
    if (request.method === SNAPSHOT_METHOD) {
      subscription.write(options.snapshotSuffix ?? "");
      socket.end(line(snapshotResponse(request.id)));
    }
  };
}

async function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await Promise.race([
    new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true })),
    Bun.sleep(MAX_ABORT_WAIT_MS).then(() => { throw new Error("focus watcher did not abort"); }),
  ]);
}

describe("picker focus subscription", () => {
  test("subscribes before snapshot and handles split and coalesced messages", async () => {
    const sameFocusEvents = focusEvent("pane_focused", { pane_id: PANE_ID, workspace_id: WORKSPACE_ID })
      + focusEvent("tab_focused", { tab_id: TAB_ID, workspace_id: WORKSPACE_ID })
      + focusEvent("workspace_focused", { workspace_id: WORKSPACE_ID });
    const server = await startServer(standardHandshake({ splitAcknowledgement: true, snapshotSuffix: sameFocusEvents }));

    try {
      const watcher = await watchPickerFocus(server.path, PANE_ID);

      expect(server.requests.map(({ method }) => method)).toEqual([SUBSCRIBE_METHOD, SNAPSHOT_METHOD]);
      expect(server.requests[0]?.params).toEqual({ subscriptions: EXPECTED_SUBSCRIPTIONS });
      expect(server.requests[1]?.params).toEqual({});
      expect(server.requests[0]?.id).not.toBe(server.requests[1]?.id);
      expect(watcher.signal.aborted).toBe(false);
      watcher.stop();
    } finally {
      await server.close();
    }
  });

  const departures = [
    ["pane focus", focusEvent("pane_focused", { pane_id: OTHER_PANE_ID, workspace_id: WORKSPACE_ID })],
    ["tab focus", focusEvent("tab_focused", { tab_id: OTHER_TAB_ID, workspace_id: WORKSPACE_ID })],
    ["workspace focus", focusEvent("workspace_focused", { workspace_id: OTHER_WORKSPACE_ID })],
  ] as const;

  for (const [label, event] of departures) {
    test(`aborts when ${label} leaves the owner`, async () => {
      let departed = false;
      const handshake = standardHandshake();
      const server = await startServer((request, socket) => {
        if (departed && request.method === SNAPSHOT_METHOD) socket.end(line(snapshotResponse(request.id, OTHER_PANE_ID)));
        else handshake(request, socket);
      });
      try {
        const watcher = await watchPickerFocus(server.path, PANE_ID);
        const socket = await server.connected;

        departed = true;
        socket.write(event);
        await waitForAbort(watcher.signal);

        expect(watcher.signal.aborted).toBe(true);
      } finally {
        await server.close();
      }
    });
  }

  test("historical focus events do not cancel the currently focused picker", async () => {
    const server = await startServer(standardHandshake());
    try {
      const watcher = await watchPickerFocus(server.path, PANE_ID);
      (await server.connected).write(focusEvent("pane_focused", { pane_id: OTHER_PANE_ID, workspace_id: WORKSPACE_ID }));
      await Bun.sleep(INPUT_SETTLE_MS);
      expect(watcher.signal.aborted).toBe(false);
      expect(server.requests.filter(request => request.method === SNAPSHOT_METHOD).length).toBeGreaterThan(1);
      watcher.stop();
    } finally { await server.close(); }
  });

  test("rejects setup when the snapshot is not globally focused", async () => {
    const server = await startServer((request, socket) => {
      if (request.method === SUBSCRIBE_METHOD) socket.write(line({ id: request.id, result: { type: "subscription_started" } }));
      if (request.method === SNAPSHOT_METHOD) socket.write(line(snapshotResponse(request.id, OTHER_PANE_ID)));
    });

    try {
      await expect(watchPickerFocus(server.path, PANE_ID)).rejects.toThrow();
    } finally {
      await server.close();
    }
  });

  test("aborts on malformed lifecycle JSON", async () => {
    const server = await startServer(standardHandshake());
    try {
      const watcher = await watchPickerFocus(server.path, PANE_ID);
      const socket = await server.connected;

      socket.write("{malformed}\n");
      await waitForAbort(watcher.signal);

      expect(watcher.signal.aborted).toBe(true);
    } finally {
      await server.close();
    }
  });

  test("aborts on a protocol error after setup", async () => {
    const server = await startServer(standardHandshake());
    try {
      const watcher = await watchPickerFocus(server.path, PANE_ID);
      const socket = await server.connected;

      socket.write(line({ id: "unexpected", error: { code: "failure", message: "secret detail" } }));
      await waitForAbort(watcher.signal);

      expect(watcher.signal.aborted).toBe(true);
      expect(String(watcher.signal.reason)).not.toContain("secret detail");
    } finally {
      await server.close();
    }
  });

  test("aborts when the active socket disconnects", async () => {
    const server = await startServer(standardHandshake());
    try {
      const watcher = await watchPickerFocus(server.path, PANE_ID);
      const socket = await server.connected;

      socket.end();
      await waitForAbort(watcher.signal);

      expect(watcher.signal.aborted).toBe(true);
    } finally {
      await server.close();
    }
  });

  test("rejects a setup protocol error", async () => {
    const server = await startServer((request, socket) => {
      socket.write(line({ id: request.id, error: { code: "failure", message: "secret detail" } }));
    });

    try {
      await expect(watchPickerFocus(server.path, PANE_ID)).rejects.toThrow();
    } finally {
      await server.close();
    }
  });

  test("rejects when the socket disconnects during setup", async () => {
    const server = await startServer((_request, socket) => socket.end());

    try {
      await expect(watchPickerFocus(server.path, PANE_ID)).rejects.toThrow();
    } finally {
      await server.close();
    }
  });

  test("rejects when setup times out", async () => {
    const server = await startServer(() => {});

    try {
      await expect(watchPickerFocus(server.path, PANE_ID)).rejects.toThrow();
    } finally {
      await server.close();
    }
  });

  test("rejects an oversized unterminated message", async () => {
    const oversized = "x".repeat(OVERSIZED_PAYLOAD_BYTES);
    const server = await startServer((_request, socket) => socket.write(oversized));

    try {
      await expect(watchPickerFocus(server.path, PANE_ID)).rejects.toThrow();
    } finally {
      await server.close();
    }
  });

  test("stop disconnects without aborting selection", async () => {
    const server = await startServer(standardHandshake());
    try {
      const watcher = await watchPickerFocus(server.path, PANE_ID);
      watcher.stop();
      await Bun.sleep(SPLIT_DELAY_MS);

      expect(watcher.signal.aborted).toBe(false);
    } finally {
      await server.close();
    }
  });
});
