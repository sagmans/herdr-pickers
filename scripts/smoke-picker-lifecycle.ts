import { Database } from "bun:sqlite";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runPickerReplacementSmoke } from "./smoke-picker-replacement.ts";

const OWNERSHIP_DATABASE_NAME = "picker-sessions.sqlite";
const OWNERSHIP_DATABASE_SETUP = "PRAGMA busy_timeout = 2000";
const OWNERSHIP_TABLE_QUERY = "SELECT session, token, opener, picker, placement, pane FROM owners";
const REQUEST_QUERY = "SELECT mode, acknowledged FROM requests WHERE session = ?";
const PICKER_PANE_LABEL = "Herdr Picker";
const WORKSPACE_PICKER_PROMPT = "workspaces ›";
const KEY_CTRL_C = "\u0003";
const KEY_ENTER = "\r";
const INPUT_SETTLE_MS = 400;
const PROCESS_PROBE_SIGNAL = 0;
const BURST_SIZE = 6;
const BURST_ACTIONS = ["workspaces", "projects", "all"] as const;
const PANE_DIRECTIONS = ["left", "right", "up", "down"] as const;
const PLUGIN_ID = "herdr-pickers";
const CONFIG_FILE_NAME = "config.toml";
const TAB_DESTINATION_LABEL = "smoke-tab-destination";
const FOCUS_EVENT_BUDGET_BYTES = 64 * 1024;
const LARGE_SESSION_LABEL = "large-session-".padEnd(96 * 1024, "x");

export interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface SmokeSession {
  readonly label: string;
  readonly rawOutputPath: string;
  run(args: readonly string[]): CliResult;
  runAsync(args: readonly string[]): Promise<CliResult>;
  input(text: string): void;
}

export interface PickerLifecycleSmokeOptions {
  readonly root: string;
  readonly repo: string;
  readonly pluginConfigDir: string;
  readonly baseConfig: string;
  readonly primary: SmokeSession;
  readonly secondary: SmokeSession;
  readonly firstWorkspaceId: string;
  readonly firstWorkspaceLabel: string;
  readonly dispatchWorkspaceId: string;
  readonly dispatchWorkspaceLabel: string;
  readonly check: (label: string, ok: boolean, detail?: string) => void;
  readonly poll: (label: string, probe: () => string | undefined) => Promise<string>;
}

type PickerPlacement = "popup" | "overlay";

interface OwnerRow {
  readonly session: string;
  readonly token: string;
  readonly opener: number;
  readonly picker: number | null;
  readonly placement: PickerPlacement;
  readonly pane: string | null;
}

interface PaneRow {
  readonly paneId: string;
  readonly focused: boolean;
  readonly label?: string;
}

interface TabRow {
  readonly tabId: string;
  readonly focused: boolean;
}

interface OpenPicker {
  readonly owner: OwnerRow;
  readonly paneId?: string;
}

export async function runPickerLifecycleSmoke(options: PickerLifecycleSmokeOptions): Promise<void> {
  const databasePath = await options.poll("picker ownership database resolves", () => findFile(options.root, OWNERSHIP_DATABASE_NAME));
  const largeWorkspace = options.primary.run(["workspace", "create", "--cwd", options.repo, "--label", LARGE_SESSION_LABEL, "--no-focus"]);
  options.check("large-session fixture creates", largeWorkspace.code === 0);
  const snapshot = options.primary.run(["api", "snapshot"]);
  options.check("session snapshot exceeds focus-event budget", snapshot.code === 0 && Buffer.byteLength(snapshot.stdout) > FOCUS_EVENT_BUDGET_BYTES);
  await runSingletonCase(options, databasePath, "popup");
  await runSingletonCase(options, databasePath, "overlay");
  await runOverlayNavigationCases(options, databasePath);
  await runPickerReplacementSmoke(options, databasePath);
  await runIndependentSessionsCase(options, databasePath);
}

async function runSingletonCase(
  options: PickerLifecycleSmokeOptions,
  databasePath: string,
  placement: PickerPlacement,
): Promise<void> {
  writePlacement(options, placement);
  focusWorkspace(options.primary, options.firstWorkspaceId, options.check);

  const opened = await openPicker(options, databasePath, options.primary, placement);
  options.primary.input(options.dispatchWorkspaceLabel);
  await Bun.sleep(INPUT_SETTLE_MS);

  const previousLogs = new Set(resultRows(options.primary.run(["plugin", "log", "list"]).stdout, "logs").map(row => row.log_id));
  const burst = await Promise.all(Array.from({ length: BURST_SIZE }, (_, index) => {
    const action = BURST_ACTIONS[index % BURST_ACTIONS.length]!;
    return options.primary.runAsync(["plugin", "action", "invoke", `${PLUGIN_ID}.${action}`]);
  }));
  const failed = burst.filter((result) => result.code !== 0);
  options.check(`${placement} burst opens exit cleanly`, failed.length === 0, failed.map((result) => result.stderr.trim()).join("; "));

  // Invocation acknowledgement precedes action completion; Enter must not race queued opens.
  await options.poll(`${placement} burst actions complete`, () => {
    const logs = resultRows(options.primary.run(["plugin", "log", "list"]).stdout, "logs")
      .filter(row => !previousLogs.has(row.log_id) && typeof row.action_id === "string" && row.status === "succeeded");
    return logs.length === BURST_SIZE ? "completed" : undefined;
  });
  const retained = ownerForSession(databasePath, opened.owner.session);
  options.check(
    `${placement} burst retains one picker owner`,
    retained?.token === opened.owner.token && retained.picker === opened.owner.picker,
    retained ? `owner token ${retained.token}` : "owner missing",
  );
  if (placement === "overlay") {
    const pickerPanes = listPanes(options.primary).filter((pane) => pane.label === PICKER_PANE_LABEL);
    options.check(
      "overlay burst retains one picker pane",
      pickerPanes.length === 1 && pickerPanes[0]?.paneId === opened.paneId,
      pickerPanes.map((pane) => pane.paneId).join(", "),
    );
  }

  const lastAction = options.primary.run(["plugin", "action", "invoke", `${PLUGIN_ID}.workspaces`]);
  options.check(`${placement} final replacement action starts`, lastAction.code === 0);
  await options.poll(`${placement} final replacement is acknowledged`, () => {
    const database = new Database(databasePath, { readonly: true });
    try {
      database.exec(OWNERSHIP_DATABASE_SETUP);
      const row = database.query<{ mode: string; acknowledged: string | null }, [string]>(
        REQUEST_QUERY,
      ).get(opened.owner.session);
      return row?.mode === "workspaces" && row.acknowledged === opened.owner.token ? row.mode : undefined;
    } finally { database.close(); }
  });
  // Request acknowledgement precedes catalog readiness; this fixture's load must finish before Enter.
  await Bun.sleep(INPUT_SETTLE_MS);
  options.primary.input(KEY_ENTER);
  await waitForWorkspaceFocus(options, options.primary, options.firstWorkspaceId, `${placement} replacement clears the previous query`);
  await waitForPickerExit(options, opened.owner, `${placement} burst picker child exits`);
  if (opened.paneId) await waitForPaneRemoval(options, options.primary, opened.paneId, "overlay burst picker pane closes");

  const reopened = await openPicker(options, databasePath, options.primary, placement, opened.owner.session);
  options.primary.input(options.firstWorkspaceLabel);
  await Bun.sleep(INPUT_SETTLE_MS);
  options.primary.input(KEY_ENTER);
  await waitForWorkspaceFocus(options, options.primary, options.firstWorkspaceId, `${placement} reopened picker dispatches`);
  await waitForPickerExit(options, reopened.owner, `${placement} reopened picker child exits`);
  if (reopened.paneId) await waitForPaneRemoval(options, options.primary, reopened.paneId, "overlay reopened picker pane closes");
}

async function runOverlayNavigationCases(options: PickerLifecycleSmokeOptions, databasePath: string): Promise<void> {
  writePlacement(options, "overlay");
  const sessionKey = onlyOwnerSession(databasePath);

  const paneDestination = focusedPaneId(options.primary);
  options.check("pane navigation destination resolves", paneDestination !== undefined, "no focused pane");
  const panePicker = await openPicker(options, databasePath, options.primary, "overlay", sessionKey);
  const direction = panePicker.paneId && paneDestination
    ? directionToPane(options.primary, panePicker.paneId, paneDestination)
    : undefined;
  options.check("picker pane has the opener as a neighbor", direction !== undefined, "no destination direction");
  const paneFocused = options.primary.run(["pane", "focus", "--direction", direction!, "--pane", panePicker.paneId!]);
  options.check("pane navigation succeeds", paneFocused.code === 0, paneFocused.stderr.trim());
  await waitForPickerExit(options, panePicker.owner, "pane navigation exits picker child");
  await waitForPaneRemoval(options, options.primary, panePicker.paneId!, "pane navigation closes picker pane");
  await waitForPaneFocus(options, options.primary, paneDestination!, "pane navigation keeps destination focused");

  const focusedWorkspace = focusedWorkspaceId(options.primary);
  const beforeTabs = new Set(listTabs(options.primary, focusedWorkspace).map((tab) => tab.tabId));
  const createdTab = options.primary.run([
    "tab", "create", "--workspace", focusedWorkspace!, "--cwd", options.repo,
    "--label", TAB_DESTINATION_LABEL, "--no-focus",
  ]);
  options.check("tab navigation destination creates", createdTab.code === 0, createdTab.stderr.trim());
  const tabDestination = await options.poll("tab navigation destination resolves", () => {
    return listTabs(options.primary, focusedWorkspace).find((tab) => !beforeTabs.has(tab.tabId))?.tabId;
  });
  const tabPicker = await openPicker(options, databasePath, options.primary, "overlay", sessionKey);
  const tabFocused = options.primary.run(["tab", "focus", tabDestination]);
  options.check("tab navigation succeeds", tabFocused.code === 0, tabFocused.stderr.trim());
  await waitForPickerExit(options, tabPicker.owner, "tab navigation exits picker child");
  await waitForPaneRemoval(options, options.primary, tabPicker.paneId!, "tab navigation closes picker pane");
  await options.poll("tab navigation keeps destination focused", () => {
    return listTabs(options.primary, focusedWorkspace).some((tab) => tab.tabId === tabDestination && tab.focused)
      ? tabDestination
      : undefined;
  });
  options.check("tab navigation keeps destination focused", true);

  const workspaceDestination = listWorkspaceIds(options.primary).find((workspaceId) => workspaceId !== focusedWorkspaceId(options.primary));
  options.check("workspace navigation destination resolves", workspaceDestination !== undefined, "no other workspace");
  const workspacePicker = await openPicker(options, databasePath, options.primary, "overlay", sessionKey);
  focusWorkspace(options.primary, workspaceDestination!, options.check);
  await waitForPickerExit(options, workspacePicker.owner, "workspace navigation exits picker child");
  await waitForPaneRemoval(options, options.primary, workspacePicker.paneId!, "workspace navigation closes picker pane");
  await waitForWorkspaceFocus(options, options.primary, workspaceDestination!, "workspace navigation keeps destination focused");

  const reopened = await openPicker(options, databasePath, options.primary, "overlay", sessionKey);
  options.primary.input(options.firstWorkspaceLabel);
  await Bun.sleep(INPUT_SETTLE_MS);
  options.primary.input(KEY_ENTER);
  await waitForWorkspaceFocus(options, options.primary, options.firstWorkspaceId, "post-navigation reopen dispatches");
  await waitForPickerExit(options, reopened.owner, "post-navigation picker child exits");
  await waitForPaneRemoval(options, options.primary, reopened.paneId!, "post-navigation picker pane closes");
}

async function runIndependentSessionsCase(options: PickerLifecycleSmokeOptions, databasePath: string): Promise<void> {
  const primaryConfig = options.primary.run(["plugin", "config-dir", PLUGIN_ID]);
  const secondaryConfig = options.secondary.run(["plugin", "config-dir", PLUGIN_ID]);
  options.check(
    "two sessions share the isolated plugin registry",
    primaryConfig.code === 0 && secondaryConfig.code === 0
      && primaryConfig.stdout.trim() === secondaryConfig.stdout.trim()
      && primaryConfig.stdout.trim() === options.pluginConfigDir,
    `${primaryConfig.stdout.trim()} / ${secondaryConfig.stdout.trim()}`,
  );

  writePlacement(options, "overlay");
  const primarySessionKey = onlyOwnerSession(databasePath);
  const primary = await openPicker(options, databasePath, options.primary, "overlay", primarySessionKey);

  writePlacement(options, "popup");
  const secondary = await openPicker(options, databasePath, options.secondary, "popup", undefined, new Set([primary.owner.session]));
  const activeOwners = readOwners(databasePath).filter((owner) => pickerAlive(owner));
  options.check(
    "shared registry sessions have independent live owners",
    activeOwners.length === 2
      && primary.owner.session !== secondary.owner.session
      && primary.owner.picker !== secondary.owner.picker,
    activeOwners.map((owner) => `${owner.placement}:${String(owner.picker)}`).join(", "),
  );

  options.primary.input(KEY_CTRL_C);
  options.secondary.input(KEY_CTRL_C);
  await Promise.all([
    waitForPickerExit(options, primary.owner, "primary independent picker child exits"),
    waitForPickerExit(options, secondary.owner, "secondary independent picker child exits"),
  ]);
  await waitForPaneRemoval(options, options.primary, primary.paneId!, "primary independent picker pane closes");
}

async function openPicker(
  options: PickerLifecycleSmokeOptions,
  databasePath: string,
  session: SmokeSession,
  placement: PickerPlacement,
  sessionKey?: string,
  excludedSessions: ReadonlySet<string> = new Set(),
): Promise<OpenPicker> {
  const previousToken = sessionKey ? ownerForSession(databasePath, sessionKey)?.token : undefined;
  const outputOffset = statSync(session.rawOutputPath).size;
  const invoked = session.run(["plugin", "action", "invoke", `${PLUGIN_ID}.workspaces`]);
  options.check(`${session.label} ${placement} picker opens`, invoked.code === 0, invoked.stderr.trim());

  const serialized = await options.poll(`${session.label} ${placement} picker claims ownership`, () => {
    const owner = readOwners(databasePath).find((candidate) => {
      if (candidate.picker === null || !pickerAlive(candidate) || candidate.placement !== placement) return false;
      if (sessionKey) return candidate.session === sessionKey && candidate.token !== previousToken;
      return !excludedSessions.has(candidate.session);
    });
    return owner ? JSON.stringify(owner) : undefined;
  });
  const owner = parseOwner(JSON.parse(serialized) as unknown);
  await options.poll(`${session.label} ${placement} picker renders`, () => {
    const output = readFileSync(session.rawOutputPath).subarray(outputOffset).toString("utf8");
    return output.includes(WORKSPACE_PICKER_PROMPT) ? "rendered" : undefined;
  });

  if (placement === "popup") return { owner };
  const paneId = await options.poll(`${session.label} overlay picker pane resolves`, () => {
    const pane = listPanes(session).find((candidate) => candidate.label === PICKER_PANE_LABEL && candidate.focused);
    return pane?.paneId;
  });
  options.check("overlay owner records its pane", owner.pane === paneId, `${String(owner.pane)} / ${paneId}`);
  return { owner, paneId };
}

function writePlacement(options: PickerLifecycleSmokeOptions, placement: PickerPlacement): void {
  const prefix = placement === "overlay" ? 'placement = "overlay"\n\n' : "";
  writeFileSync(join(options.pluginConfigDir, CONFIG_FILE_NAME), `${prefix}${options.baseConfig}`, "utf8");
}

function readOwners(databasePath: string): OwnerRow[] {
  const database = new Database(databasePath, { readonly: true });
  try {
    database.exec(OWNERSHIP_DATABASE_SETUP);
    return database.query<unknown, []>(OWNERSHIP_TABLE_QUERY).all().map(parseOwner);
  } finally {
    database.close();
  }
}

function parseOwner(value: unknown): OwnerRow {
  if (!value || typeof value !== "object") throw new Error("invalid picker owner row");
  const row = value as Record<string, unknown>;
  const placement = row.placement;
  if (typeof row.session !== "string" || typeof row.token !== "string"
    || typeof row.opener !== "number" || (typeof row.picker !== "number" && row.picker !== null)
    || (placement !== "popup" && placement !== "overlay")
    || (typeof row.pane !== "string" && row.pane !== null)) {
    throw new Error("invalid picker owner row");
  }
  return {
    session: row.session,
    token: row.token,
    opener: row.opener,
    picker: row.picker,
    placement,
    pane: row.pane,
  };
}

function ownerForSession(databasePath: string, session: string): OwnerRow | undefined {
  return readOwners(databasePath).find((owner) => owner.session === session);
}

function onlyOwnerSession(databasePath: string): string {
  const sessions = new Set(readOwners(databasePath).map((owner) => owner.session));
  if (sessions.size !== 1) throw new Error(`expected one picker session owner, found ${sessions.size}`);
  return [...sessions][0]!;
}

const pickerAlive = (owner: OwnerRow): boolean => owner.picker !== null && processAlive(owner.picker);

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, PROCESS_PROBE_SIGNAL);
    return true;
  } catch (error) {
    return errorCode(error) !== "ESRCH";
  }
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

async function waitForPickerExit(options: PickerLifecycleSmokeOptions, owner: OwnerRow, label: string): Promise<void> {
  await options.poll(label, () => owner.picker !== null && !processAlive(owner.picker) ? owner.token : undefined);
  options.check(label, true);
}

async function waitForPaneRemoval(
  options: PickerLifecycleSmokeOptions,
  session: SmokeSession,
  paneId: string,
  label: string,
): Promise<void> {
  await options.poll(label, () => listPanes(session).some((pane) => pane.paneId === paneId) ? undefined : paneId);
  options.check(label, true);
}

async function waitForWorkspaceFocus(
  options: PickerLifecycleSmokeOptions,
  session: SmokeSession,
  workspaceId: string,
  label: string,
): Promise<void> {
  await options.poll(label, () => focusedWorkspaceId(session) === workspaceId ? workspaceId : undefined);
  options.check(label, true);
}

async function waitForPaneFocus(
  options: PickerLifecycleSmokeOptions,
  session: SmokeSession,
  paneId: string,
  label: string,
): Promise<void> {
  await options.poll(label, () => focusedPaneId(session) === paneId ? paneId : undefined);
  options.check(label, true);
}

function focusWorkspace(session: SmokeSession, workspaceId: string, check: PickerLifecycleSmokeOptions["check"]): void {
  const focused = session.run(["workspace", "focus", workspaceId]);
  check(`workspace ${workspaceId} focuses`, focused.code === 0, focused.stderr.trim());
}

function focusedWorkspaceId(session: SmokeSession): string | undefined {
  const result = session.run(["workspace", "list"]);
  if (result.code !== 0) return undefined;
  const rows = resultRows(result.stdout, "workspaces");
  return rows.find((row) => row.focused === true && typeof row.workspace_id === "string")?.workspace_id as string | undefined;
}

function listWorkspaceIds(session: SmokeSession): string[] {
  const result = session.run(["workspace", "list"]);
  if (result.code !== 0) return [];
  return resultRows(result.stdout, "workspaces")
    .map((row) => typeof row.workspace_id === "string" ? row.workspace_id : undefined)
    .filter((value): value is string => value !== undefined);
}

function listPanes(session: SmokeSession): PaneRow[] {
  const result = session.run(["pane", "list"]);
  if (result.code !== 0) throw new Error("Cannot verify picker pane teardown");
  return resultRows(result.stdout, "panes").flatMap((row) => {
    if (typeof row.pane_id !== "string") throw new Error("Invalid picker pane identity");
    return [{
      paneId: row.pane_id,
      focused: row.focused === true,
      ...(typeof row.label === "string" ? { label: row.label } : {}),
    }];
  });
}

function focusedPaneId(session: SmokeSession): string | undefined {
  return listPanes(session).find((pane) => pane.focused)?.paneId;
}

function listTabs(session: SmokeSession, workspaceId?: string): TabRow[] {
  const result = session.run(["tab", "list", ...(workspaceId ? ["--workspace", workspaceId] : [])]);
  if (result.code !== 0) return [];
  return resultRows(result.stdout, "tabs").flatMap((row) => {
    if (typeof row.tab_id !== "string") return [];
    return [{ tabId: row.tab_id, focused: row.focused === true }];
  });
}

function directionToPane(session: SmokeSession, sourcePaneId: string, destinationPaneId: string): (typeof PANE_DIRECTIONS)[number] | undefined {
  return PANE_DIRECTIONS.find((direction) => {
    const neighbor = session.run(["pane", "neighbor", "--direction", direction, "--pane", sourcePaneId]);
    return neighbor.code === 0 && findId(neighbor.stdout, "neighbor_pane_id") === destinationPaneId;
  });
}

function findId(stdout: string, key: string): string | undefined {
  try {
    return findString(JSON.parse(stdout) as unknown, key);
  } catch {
    return undefined;
  }
}

function findString(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record[key] === "string") return record[key];
  for (const child of Object.values(record)) {
    const found = findString(child, key);
    if (found) return found;
  }
  return undefined;
}

function resultRows(stdout: string, key: string): Array<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(stdout) as { result?: Record<string, unknown> };
    const rows = parsed.result?.[key];
    if (!Array.isArray(rows) || rows.some(row => !row || typeof row !== "object")) throw new Error("Invalid smoke response");
    return rows as Array<Record<string, unknown>>;
  } catch {
    throw new Error("Cannot verify smoke response rows");
  }
}

function findFile(root: string, name: string): string | undefined {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isFile() && entry.name === name) return path;
    if (entry.isDirectory()) {
      const nested = findFile(path, name);
      if (nested) return nested;
    }
  }
  return undefined;
}

