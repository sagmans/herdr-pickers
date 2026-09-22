// Host safety: every herdr process and CLI call runs with all four XDG base
// dirs redirected into a temp root, so config, sessions, sockets, and plugin
// state never touch the host installation. The script aborts before any
// mutation unless the session socket is verified to live under the temp root.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { runPickerLifecycleSmoke, type CliResult, type SmokeSession } from "./smoke-picker-lifecycle.ts";
import {
  POLL_BACKOFF_FACTOR,
  POLL_INTERVAL_MAX_MS,
  POLL_INTERVAL_MS,
  POLL_TIMEOUT_EXTENDED_MS,
  POLL_TIMEOUT_MS,
} from "./smoke-timing.ts";

const PLUGIN_ROOT = join(import.meta.dir, "..");
const PLUGIN_ID = "herdr-pickers";
const CONFIG_FILE_NAME = "config.toml";
const XDG_CONFIG_DIR = "x";
const XDG_STATE_DIR = "s";
const HERDR_CONFIG_DIR = "herdr";
// Herdr spreads plugin state below the state home; the smoke looks the file up
// instead of assuming the layout so a Herdr change fails loudly.
const PLUGIN_STATE_FILE_NAME = "state.json";
const PLUGIN_STATE_SEARCH_DEPTH = 4;
const PLUGIN_STATE_CURRENT_KEY = "current_workspace_id";
const PLUGIN_STATE_PREVIOUS_KEY = "last_workspace_id";
const HERDR_ONBOARDING_COMPLETE = "onboarding = false\n";
const SMOKE_CONFIG = '[keymap]\nup = ["up", "ctrl-k"]\ndown = ["down", "ctrl-j"]\n';
const KEY_CTRL_C = "\u0003";
const KEY_CTRL_J = "\u000a";
const KEY_ENTER = "\r";
const KEY_ESCAPE = "\u001b";
const KEY_INPUT_SETTLE_MS = 100;
const CLIENT_EXIT_GRACE_MS = 1_000;
const PICKER_PANE_LABEL = "Herdr Picker";
const SMOKE_QUERY = "smoke-";
const FIRST_WORKSPACE_ID = "w1";
const FIRST_WORKSPACE_LABEL = "smoke-one";
const SEEDED_WORKSPACE_ID = "w2";
const DISPATCH_TARGET_WORKSPACE_ID = "w3";
const DISPATCH_TARGET_WORKSPACE_LABEL = "smoke-two";
const FIXTURE_DEFAULT_BRANCH = "main";
const FIXTURE_WORKTREE_BRANCH = "feature";
const SESSION_SUFFIX = Date.now().toString(36);
const SESSION_NAME = `s-${SESSION_SUFFIX}`;
const SECOND_SESSION_NAME = `t-${SESSION_SUFFIX}`;
const SECOND_SESSION_CHECK_PREFIX = "second ";
const SECOND_SESSION_WORKSPACE_LABEL = "smoke-second-session";
const ACTION_IDS = [
  "all", "projects", "workspaces", "repo-workspaces", "worktrees",
  "repo-worktrees", "agents", "repo-agents", "last-workspace",
] as const;
const WORKSPACES_PICKER_PROMPT = "workspaces ›";
// A terminal escape sequence in the client stream proves a real TUI frame was
// painted; the raw PTY file exists as soon as the bridge starts.
const CLIENT_PAINT_MARKER = "\u001b[";
// Picker labels reach the client as UTF-8, so prompt matching must decode the
// raw PTY stream the same way; the ASCII escape marker survives either codec.
const CLIENT_OUTPUT_ENCODING = "utf8";

// Mouse regression fixtures: the overlay picker renders one display row per
// result, and the tallest supported pane is the 40-row client itself (36 result
// rows). More workspaces than that guarantee a scrollable list everywhere.
const MOUSE_SCROLL_FIXTURE_COUNT = 40;
const MOUSE_SCROLL_FIXTURE_LABEL_PREFIX = "smoke-scroll-";
const MOUSE_SCROLL_FIXTURE_LABEL_DIGITS = 2;
const MOUSE_SETTLE_FRAME_INITIAL = "";

// SGR mouse reports are the terminal protocol itself, so the picker receives
// them through ordinary pane input; the coordinates are 1-based pane cells.
const SGR_MOUSE_PREFIX = "\u001b[<";
const SGR_MOUSE_PRESS_SUFFIX = "M";
const SGR_MOUSE_RELEASE_SUFFIX = "m";
const SGR_BUTTON_LEFT = 0;
const SGR_BUTTON_WHEEL_UP = 64;
const SGR_BUTTON_WHEEL_DOWN = 65;
const MOUSE_CLICK_COLUMN = 3;
const MOUSE_WHEEL_ROW = 2;
// Wheel deltas clamp at the list edges, so the probe normalizes to the top
// with a burst and then compares single steps.
const MOUSE_WHEEL_NORMALIZE_EVENTS = 12;
const POINTER_GLYPH = "→";
// The picker dispatches a double click when both presses land inside its
// double-click window; one pane write keeps them far inside it even on a
// loaded runner.
const MOUSE_DOUBLE_CLICK_GAP_MILLISECONDS = 600;

// Short root: herdr socket paths must stay under the sockaddr_un sun_path
// limit (104 bytes on macOS), which rules out long tmpdir prefixes.
const root = mkdtempSync("/tmp/hps-");
const fixtureRoot = join(root, "fixture");
const serverLog = join(root, "server.log");
const secondServerLog = join(root, "server-second.log");
const clientRawPath = join(root, "client.raw");
const secondClientRawPath = join(root, "client-second.raw");

function clientBytes(): number {
  try { return statSync(clientRawPath).size; } catch { return 0; }
}

// Environment that routes every herdr invocation into the isolated config.
function isolatedEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key.startsWith("HERDR_")) continue;
    env[key] = value;
  }
  // XDG_CONFIG_HOME redirects herdr's whole tree (config, sessions,
  // plugin registry, sockets) into the temp root; HERDR_CONFIG_PATH alone
  // only moves the config file, not the sessions directory.
  // herdr spreads state across every XDG base dir; redirecting only
  // XDG_CONFIG_HOME leaked plugin state into the host ~/.local/state.
  env.XDG_CONFIG_HOME = join(root, XDG_CONFIG_DIR);
  env.XDG_STATE_HOME = join(root, XDG_STATE_DIR);
  env.XDG_DATA_HOME = join(root, "d");
  env.XDG_CACHE_HOME = join(root, "c");
  return env;
}

const cli = (args: readonly string[]): CliResult => cliFor(SESSION_NAME, args);

function cliFor(sessionName: string, args: readonly string[]): CliResult {
  try {
    const stdout = execFileSync("herdr", [...args], {
      env: { ...isolatedEnv(), HERDR_SESSION: sessionName },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout, stderr: "" };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { code: failure.status ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

async function cliAsyncFor(sessionName: string, args: readonly string[]): Promise<CliResult> {
  const proc = Bun.spawn(["herdr", ...args], {
    env: { ...isolatedEnv(), HERDR_SESSION: sessionName },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

function check(label: string, ok: boolean, detail?: string): void {
  console.error(`${ok ? "ok" : "FAIL"}  ${label}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) finish(1);
}

async function poll(
  label: string,
  probe: () => string | undefined,
  timeoutMs: number = POLL_TIMEOUT_MS,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let interval = POLL_INTERVAL_MS;
  let probeError: string | undefined;
  for (;;) {
    try {
      const value = probe();
      if (value !== undefined) return value;
      probeError = undefined;
    } catch (error) {
      // A transient probe failure while a picker starts must not end the run;
      // the last error is reported if the deadline expires.
      probeError = error instanceof Error ? error.message : String(error);
    }
    if (Date.now() > deadline) {
      check(label, false, `timed out after ${timeoutMs} ms${probeError === undefined ? "" : ` (last probe error: ${probeError})`}`);
      return "";
    }
    await Bun.sleep(interval);
    interval = Math.min(POLL_INTERVAL_MAX_MS, Math.round(interval * POLL_BACKOFF_FACTOR));
  }
}

const isolatedSessions = new Set<string>();

async function verifySessionIsolation(sessionName: string, label: string): Promise<void> {
  await poll(`${label}server becomes ready`, () => cliFor(sessionName, ["pane", "list"]).code === 0 ? "ready" : undefined);
  const status = cliFor(sessionName, ["status", "server"]);
  check(`${label}runtime is isolated under temp config`, status.code === 0 && status.stdout.includes(`${root}/`),
    `unexpected socket path in: ${status.stdout.trim()}`);
  isolatedSessions.add(sessionName);
}

let server: Bun.Subprocess<"ignore", number, number> | undefined;
let secondServer: Bun.Subprocess<"ignore", number, number> | undefined;
let attach: Bun.Subprocess<"pipe", number, "ignore"> | undefined;
let secondAttach: Bun.Subprocess<"pipe", number, "ignore"> | undefined;

function sendInput(proc: typeof attach, text: string): void {
  if (!proc) throw new Error("smoke PTY is not attached");
  proc.stdin.write(text);
}

function finish(code: number): never {
  if (code !== 0) {
    console.error(`keeping smoke root for inspection: ${root}`);
    for (const sessionName of isolatedSessions) {
      writeFileSync(join(root, `${sessionName}-plugins.json`), cliFor(sessionName, ["plugin", "log", "list"]).stdout);
    }
  }
  if (isolatedSessions.has(SESSION_NAME)) cli(["plugin", "unlink", PLUGIN_ID]);
  for (const sessionName of [SESSION_NAME, SECOND_SESSION_NAME]) {
    if (!isolatedSessions.has(sessionName)) continue;
    cliFor(sessionName, ["session", "stop", sessionName]);
    cliFor(sessionName, ["session", "delete", sessionName]);
  }
  for (const proc of [server, secondServer]) {
    if (!proc) continue;
    try { proc.kill(); } catch { /* already gone */ }
  }
  // Attached TUI clients exit once their session disappears. Signalling them
  // first wedged them in exit on macOS, and their PTY bridges then waited
  // forever, so let the session shutdown reach them before the fallback kill.
  Bun.sleepSync(CLIENT_EXIT_GRACE_MS);
  for (const proc of [attach, secondAttach]) {
    if (!proc) continue;
    try { proc.kill(); } catch { /* already gone */ }
  }
  if (code === 0) {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  process.exit(code);
}

const git = (cwd: string, ...args: string[]): void => execFileSync("git", args, { cwd, stdio: "ignore" });

function listPanes(): Array<{ pane_id: string; label?: string; focused?: boolean }> | undefined {
  const result = cli(["pane", "list"]);
  if (result.code !== 0) return undefined;
  try {
    const parsed = JSON.parse(result.stdout) as { result?: { panes?: Array<{ pane_id: string; label?: string; focused?: boolean }> } };
    const panes = parsed.result?.panes;
    if (!Array.isArray(panes) || panes.some((pane) => !pane || typeof pane.pane_id !== "string")) return undefined;
    return panes;
  } catch {
    return undefined;
  }
}

async function waitForOverlayPicker(): Promise<string> {
  // Other panes can redraw before the picker exists, so client byte counts
  // cannot prove that cancellation input will reach the picker.
  return poll("overlay picker renders", () => {
    const panes = listPanes();
    if (panes === undefined) return undefined;
    const pane = panes.find((candidate) => candidate.label === PICKER_PANE_LABEL && candidate.focused === true);
    if (!pane) {
      // A picker pane that exists but never takes focus is the interesting
      // timeout, so the failure detail reports it instead of "no pane".
      const unfocused = panes.filter((candidate) => candidate.label === PICKER_PANE_LABEL);
      if (unfocused.length > 0) throw new Error(`picker pane exists without focus: ${JSON.stringify(unfocused)}`);
      return undefined;
    }
    const text = visiblePaneText(pane.pane_id);
    if (text === undefined) throw new Error(`pane read failed for ${pane.pane_id}`);
    if (!text.includes(WORKSPACES_PICKER_PROMPT)) throw new Error(`pane ${pane.pane_id} shows: ${JSON.stringify(text.slice(0, 160))}`);
    return pane.pane_id;
  }, POLL_TIMEOUT_EXTENDED_MS);
}

async function waitForPaneRemoval(label: string, paneId: string): Promise<void> {
  await poll(label, () => listPanes()?.some((pane) => pane.pane_id === paneId) === false ? paneId : undefined);
  check(label, true);
}

function visiblePaneText(paneId: string): string | undefined {
  const output = cli(["pane", "read", paneId, "--source", "visible", "--format", "text"]);
  return output.code === 0 ? output.stdout : undefined;
}

function readClientOutput(path: string): string {
  try { return readFileSync(path, CLIENT_OUTPUT_ENCODING); } catch { return ""; }
}

interface WorkspaceListRow {
  readonly workspace_id?: string;
  readonly label?: string;
  readonly focused?: boolean;
}

function listWorkspaceRows(): WorkspaceListRow[] {
  const result = cli(["workspace", "list"]);
  if (result.code !== 0) return [];
  try {
    const parsed = JSON.parse(result.stdout) as { result?: { workspaces?: WorkspaceListRow[] } };
    return parsed.result?.workspaces ?? [];
  } catch {
    return [];
  }
}

function focusedWorkspaceId(): string | undefined {
  return listWorkspaceRows().find((workspace) => workspace.focused)?.workspace_id;
}

function workspaceIdForLabel(label: string): string | undefined {
  return listWorkspaceRows().find((workspace) => workspace.label === label)?.workspace_id;
}

// Client readiness is an event, not a fixed delay: a loaded runner can take
// longer than any sleep to connect and paint, and keystrokes sent before the
// first frame land in the shell instead of the picker.
async function waitForClientPaint(label: string, rawOutputPath: string): Promise<void> {
  await poll(label, () => readClientOutput(rawOutputPath).includes(CLIENT_PAINT_MARKER) ? "painted" : undefined, POLL_TIMEOUT_EXTENDED_MS);
  check(label, true);
}

async function waitForPickerPrompt(label: string, rawOutputPath: string): Promise<void> {
  await poll(label, () => readClientOutput(rawOutputPath).includes(WORKSPACES_PICKER_PROMPT) ? "rendered" : undefined, POLL_TIMEOUT_EXTENDED_MS);
  check(label, true);
}

interface LastWorkspaceState {
  readonly current?: string;
  readonly previous?: string;
}

let pluginStatePath: string | undefined;

// Focus history is written by a one-shot event process, so the toggle action
// must not run until the transition it depends on is persisted; polling the
// file is the only observable the smoke has for that write.
async function waitForLastWorkspaceState(label: string, current: string, previous?: string): Promise<void> {
  await poll(label, () => {
    const state = readLastWorkspaceState();
    if (state?.current !== current) return undefined;
    if (previous !== undefined && state.previous !== previous) return undefined;
    return state.previous ?? current;
  }, POLL_TIMEOUT_EXTENDED_MS);
  check(label, true);
}

function readLastWorkspaceState(): LastWorkspaceState | undefined {
  pluginStatePath ??= findPluginStateFile(join(root, XDG_STATE_DIR), PLUGIN_STATE_SEARCH_DEPTH);
  if (pluginStatePath === undefined) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(pluginStatePath, "utf8")) as Record<string, unknown>;
    const current = parsed[PLUGIN_STATE_CURRENT_KEY];
    const previous = parsed[PLUGIN_STATE_PREVIOUS_KEY];
    return {
      current: typeof current === "string" ? current : undefined,
      previous: typeof previous === "string" ? previous : undefined,
    };
  } catch {
    return undefined;
  }
}

function findPluginStateFile(directory: string, depth: number): string | undefined {
  if (depth < 0) return undefined;
  try {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isFile() && entry.name === PLUGIN_STATE_FILE_NAME) return path;
      if (entry.isDirectory()) {
        const nested = findPluginStateFile(path, depth - 1);
        if (nested !== undefined) return nested;
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function mouseScrollFixtureLabel(index: number): string {
  return `${MOUSE_SCROLL_FIXTURE_LABEL_PREFIX}${String(index).padStart(MOUSE_SCROLL_FIXTURE_LABEL_DIGITS, "0")}`;
}

function sgrMouseReport(button: number, row: number, released: boolean): string {
  return `${SGR_MOUSE_PREFIX}${button};${MOUSE_CLICK_COLUMN};${row}${released ? SGR_MOUSE_RELEASE_SUFFIX : SGR_MOUSE_PRESS_SUFFIX}`;
}

function sgrMouseClick(row: number): string {
  return sgrMouseReport(SGR_BUTTON_LEFT, row, false) + sgrMouseReport(SGR_BUTTON_LEFT, row, true);
}

function sgrMouseWheel(button: number, events: number): string {
  return Array.from({ length: events }, () => sgrMouseReport(button, MOUSE_WHEEL_ROW, false)).join("");
}

// The picker renders one result per display row, so a visible line match maps
// directly to the 1-based pane row a terminal would report for that cell.
function visibleRowOf(text: string, marker: string): number | undefined {
  const index = text.split("\n").findIndex((line) => line.includes(marker));
  return index < 0 ? undefined : index + 1;
}

function lineHasPointer(text: string, marker: string): boolean {
  const line = text.split("\n").find((row) => row.includes(marker));
  return line !== undefined && line.trimStart().startsWith(POINTER_GLYPH);
}

function visibleScrollFixtureLabels(text: string): string[] {
  return text.split("\n").flatMap((line) => {
    const start = line.indexOf(MOUSE_SCROLL_FIXTURE_LABEL_PREFIX);
    if (start < 0) return [];
    return [line.slice(start, start + MOUSE_SCROLL_FIXTURE_LABEL_PREFIX.length + MOUSE_SCROLL_FIXTURE_LABEL_DIGITS)];
  });
}

function sameLabels(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((label, index) => label === right[index]);
}

// A pane read can land while the picker is still painting, and a torn frame
// yields both wrong rows and wrong scroll comparisons; requiring two identical
// consecutive reads makes every later assertion act on a quiesced screen.
async function waitForSettledFrame(label: string, paneId: string): Promise<string> {
  let previous = MOUSE_SETTLE_FRAME_INITIAL;
  return poll(label, () => {
    const text = visiblePaneText(paneId);
    if (text === undefined) return undefined;
    const settled = text === previous ? text : undefined;
    previous = text;
    return settled;
  }, POLL_TIMEOUT_EXTENDED_MS);
}

async function sendPaneInput(paneId: string, label: string, text: string): Promise<void> {
  const sent = cli(["pane", "send-text", paneId, text]);
  check(label, sent.code === 0, sent.stderr.trim());
}

// Mouse behaviour is not visible to the popup smoke path: Herdr renders popups
// itself, but the overlay picker owns a real pane whose PTY the probe can drive
// and read. The wheel, click, and double-click assertions below mirror the
// manual checks RELEASE.md requires before every release.
async function runOverlayMouseSmoke(repo: string): Promise<void> {
  const failures: string[] = [];
  for (let index = 0; index < MOUSE_SCROLL_FIXTURE_COUNT; index += 1) {
    const label = mouseScrollFixtureLabel(index);
    const created = cli(["workspace", "create", "--cwd", repo, "--label", label, "--no-focus"]);
    if (created.code !== 0) failures.push(`${label}: ${created.stderr.trim()}`);
  }
  check("overlay wheel fixtures create", failures.length === 0, failures.join("; "));

  const opened = cli(["plugin", "action", "invoke", `${PLUGIN_ID}.workspaces`]);
  check("overlay mouse picker opens", opened.code === 0, opened.stderr.trim());
  const paneId = await waitForOverlayPicker();
  const initialFrame = await waitForSettledFrame("overlay mouse picker settles", paneId);
  const visibleFixtures = visibleScrollFixtureLabels(initialFrame);
  // Without clipping there is nothing to scroll, and the wheel assertions
  // would pass or fail for the wrong reason.
  check(
    "overlay wheel fixtures overflow the picker viewport",
    visibleFixtures.length < MOUSE_SCROLL_FIXTURE_COUNT,
    `visible fixtures ${visibleFixtures.length} of ${MOUSE_SCROLL_FIXTURE_COUNT}`,
  );

  // The picker opens scrolled to the current workspace, and wheel deltas clamp
  // at the list edges, so normalize to the list top before measuring single
  // steps; only then is one step down and one step up a true round trip.
  await sendPaneInput(paneId, "overlay wheel input reaches the picker", sgrMouseWheel(SGR_BUTTON_WHEEL_UP, MOUSE_WHEEL_NORMALIZE_EVENTS));
  const normalizedFrame = await waitForSettledFrame("overlay wheel normalizes to the list top", paneId);
  const normalizedLabels = visibleScrollFixtureLabels(normalizedFrame);

  // Comparing the whole visible sequence matters: the list also holds other
  // workspace rows, so a scroll can move every fixture while leaving the first
  // one in place.
  await sendPaneInput(paneId, "overlay wheel down reaches the picker", sgrMouseWheel(SGR_BUTTON_WHEEL_DOWN, 1));
  await poll("overlay wheel scrolls the fixture list", () => {
    const text = visiblePaneText(paneId);
    return text !== undefined && !sameLabels(visibleScrollFixtureLabels(text), normalizedLabels) ? text : undefined;
  });
  check("overlay wheel scrolls the fixture list", true);

  await sendPaneInput(paneId, "overlay wheel up reaches the picker", sgrMouseWheel(SGR_BUTTON_WHEEL_UP, 1));
  await poll("overlay wheel restores the fixture list", () => {
    const text = visiblePaneText(paneId);
    return text !== undefined && sameLabels(visibleScrollFixtureLabels(text), normalizedLabels) ? text : undefined;
  });
  check("overlay wheel restores the fixture list", true);

  const clickFrame = await waitForSettledFrame("overlay mouse click frame settles", paneId);
  // The wheel round trip leaves a selection somewhere in the list, and clicking
  // an already selected row would prove nothing about row mapping; the last
  // unselected fixture row also covers the bottom of the viewport.
  const clickCandidates = visibleScrollFixtureLabels(clickFrame).filter((label) => !lineHasPointer(clickFrame, label));
  const clickLabel = clickCandidates[clickCandidates.length - 1];
  if (clickLabel === undefined) {
    check("overlay mouse click target resolves", false, "no unselected fixture row is visible");
    return;
  }
  const clickRow = visibleRowOf(clickFrame, clickLabel);
  if (clickRow === undefined) {
    check("overlay mouse click row resolves", false, clickLabel);
    return;
  }
  await sendPaneInput(paneId, `overlay click reaches the picker (${clickLabel})`, sgrMouseClick(clickRow));
  await poll(`overlay click selects ${clickLabel}`, () => {
    const text = visiblePaneText(paneId);
    return text !== undefined && lineHasPointer(text, clickLabel) ? "selected" : undefined;
  });
  check(`overlay click selects ${clickLabel}`, true);

  const clickedWorkspaceId = workspaceIdForLabel(clickLabel);
  if (clickedWorkspaceId === undefined) {
    check("overlay double-click target resolves to a workspace", false, clickLabel);
    return;
  }
  // The select click already opened the double-click window, so wait it out
  // before sending the dispatch pair; both presses then travel in one pane
  // write, far inside the picker's own window even on a loaded runner.
  await Bun.sleep(MOUSE_DOUBLE_CLICK_GAP_MILLISECONDS);
  await sendPaneInput(paneId, `overlay double click reaches the picker (${clickLabel})`, sgrMouseClick(clickRow) + sgrMouseClick(clickRow));
  await poll(`overlay double click dispatches ${clickLabel}`, () => focusedWorkspaceId() === clickedWorkspaceId ? clickedWorkspaceId : undefined);
  check(`overlay double click dispatches ${clickLabel}`, true);
  await waitForPaneRemoval("overlay double click closes the picker pane", paneId);
  check("client stays attached after overlay mouse input", attach?.exitCode === null);

  // Reopening after the mouse traffic proves the pane still accepts input and
  // that the picker restored the terminal state it enabled for mouse tracking.
  const reopened = cli(["plugin", "action", "invoke", `${PLUGIN_ID}.workspaces`]);
  check("overlay picker reopens after mouse input", reopened.code === 0, reopened.stderr.trim());
  const reopenedPaneId = await waitForOverlayPicker();
  sendInput(attach, KEY_ESCAPE);
  await waitForPaneRemoval("overlay escape still closes after mouse input", reopenedPaneId);
}

async function main(): Promise<void> {
  console.error(`smoke root: ${root}`);
  mkdirSync(fixtureRoot, { recursive: true });
  // herdr 0.9.x renders setup in each client, and a fresh config still shows
  // first-run onboarding that captures input before plugin popups. Real
  // installations have completed it, so the isolated runtime must match.
  const herdrConfigDir = join(root, XDG_CONFIG_DIR, HERDR_CONFIG_DIR);
  mkdirSync(herdrConfigDir, { recursive: true });
  writeFileSync(join(herdrConfigDir, CONFIG_FILE_NAME), HERDR_ONBOARDING_COMPLETE, "utf8");

  const logFd = openSync(serverLog, "a");
  server = Bun.spawn(["herdr", "--session", SESSION_NAME, "server"], {
    env: { ...isolatedEnv(), HERDR_SESSION: SESSION_NAME },
    stdin: "ignore",
    stdout: logFd,
    stderr: logFd,
  });

  // No Herdr mutation is allowed until its session socket proves isolation.
  await verifySessionIsolation(SESSION_NAME, "");

  const repo = join(fixtureRoot, "sample-repo");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", FIXTURE_DEFAULT_BRANCH);
  // Reusing signed history avoids weakening Git policy; CI's shallow checkout must remain fetchable.
  git(repo, "fetch", "-q", "--no-tags", "--update-shallow", PLUGIN_ROOT, "HEAD");
  git(repo, "checkout", "-q", "-B", FIXTURE_DEFAULT_BRANCH, "FETCH_HEAD");
  git(repo, "worktree", "add", "-q", join(fixtureRoot, "sample-repo-wt"), "-b", FIXTURE_WORKTREE_BRANCH);

  // Herdr focuses the first workspace because it is alone at creation time;
  // eviltwo carries an adversarial label, and smoke-two is the dispatch target.
  const created = cli(["workspace", "create", "--cwd", repo, "--label", FIRST_WORKSPACE_LABEL, "--no-focus"]);
  check("workspace create succeeds", created.code === 0, created.stderr.trim());
  const adversarialLabel = "evil\u001B]0;pwn\u0007two\u2066";
  const createdTwo = cli(["workspace", "create", "--cwd", join(fixtureRoot, "sample-repo-wt"), "--label", adversarialLabel, "--no-focus"]);
  check("adversarial workspace create succeeds", createdTwo.code === 0, createdTwo.stderr.trim());
  const createdThree = cli(["workspace", "create", "--cwd", repo, "--label", DISPATCH_TARGET_WORKSPACE_LABEL, "--no-focus"]);
  check("dispatch-target workspace create succeeds", createdThree.code === 0, createdThree.stderr.trim());

  const linked = cli(["plugin", "link", PLUGIN_ROOT, "--enabled"]);
  check("plugin links", linked.code === 0, linked.stderr.trim());
  const configDirResult = cli(["plugin", "config-dir", PLUGIN_ID]);
  check("plugin config directory resolves", configDirResult.code === 0, configDirResult.stderr.trim());
  const pluginConfigDir = configDirResult.stdout.trim();
  check("plugin config remains isolated", pluginConfigDir.startsWith(`${root}/`), pluginConfigDir);
  mkdirSync(pluginConfigDir, { recursive: true });
  writeFileSync(join(pluginConfigDir, CONFIG_FILE_NAME), SMOKE_CONFIG, "utf8");

  const actions = cli(["plugin", "action", "list", "--plugin", "herdr-pickers"]);
  let registered: string[] = [];
  try {
    const parsed = JSON.parse(actions.stdout) as { result?: { actions?: Array<{ action_id?: string }> } };
    registered = (parsed.result?.actions ?? []).map((action) => action.action_id ?? "").sort();
  } catch { /* handled by check */ }
  check("all nine actions register", JSON.stringify(registered) === JSON.stringify([...ACTION_IDS].sort()),
    `registered: ${registered.join(", ")}`);

  // A real PTY is required because popup input routes through the attached client.
  const clientRaw = openSync(clientRawPath, "a");
  attach = Bun.spawn([
    "python3", join(import.meta.dir, "smoke-pty.py"), "herdr", "--session", SESSION_NAME,
  ], {
    env: { ...isolatedEnv(), HERDR_SESSION: SESSION_NAME, TERM: "xterm-256color" },
    stdin: "pipe",
    stdout: clientRaw,
    stderr: "ignore",
  });
  await waitForClientPaint("primary client paints its first frame", clientRawPath);
  // Focus history is what last-workspace toggles through: seed one
  // transition (w1 -> w2) so the later picker dispatch (-> w3) records w2
  // as the previous workspace.
  const seeded = cli(["workspace", "focus", SEEDED_WORKSPACE_ID]);
  check("focus transition seeds last-workspace memory", seeded.code === 0, seeded.stderr.trim());
  await waitForLastWorkspaceState("last-workspace memory records the seed focus", SEEDED_WORKSPACE_ID);

  const opened = cli(["plugin", "action", "invoke", "herdr-pickers.workspaces"]);
  check("workspaces action exits cleanly", opened.code === 0, opened.stderr.trim());
  const before = focusedWorkspaceId();
  // Keys route to the focused shell pane until the popup paints, so wait for
  // its prompt instead of guessing how long the render takes.
  await waitForPickerPrompt("configured ctrl-j picker renders", clientRawPath);
  sendInput(attach, SMOKE_QUERY);
  await Bun.sleep(400);
  sendInput(attach, KEY_CTRL_J);
  await Bun.sleep(KEY_INPUT_SETTLE_MS);
  // CR keeps acceptance distinct from Ctrl-J's indistinguishable LF byte.
  sendInput(attach, KEY_ENTER);
  const configuredSelection = await poll("configured ctrl-j selection", () => {
    const focused = focusedWorkspaceId();
    return focused === DISPATCH_TARGET_WORKSPACE_ID ? focused : undefined;
  });
  check(
    "configured ctrl-j dispatches the next selection",
    configuredSelection === DISPATCH_TARGET_WORKSPACE_ID,
    configuredSelection,
  );

  // The toggle restores whatever the event process recorded last, so the
  // dispatched transition must be persisted before the action reads it.
  await waitForLastWorkspaceState("last-workspace memory records the dispatched focus", DISPATCH_TARGET_WORKSPACE_ID, before);
  const toggled = cli(["plugin", "action", "invoke", "herdr-pickers.last-workspace"]);
  check("last-workspace action exits cleanly", toggled.code === 0, toggled.stderr.trim());
  await poll("last-workspace restores the previous focus", () => {
    const focused = focusedWorkspaceId();
    return focused === before ? focused : undefined;
  });

  const bytesBeforeProjects = clientBytes();
  const projects = cli(["plugin", "action", "invoke", "herdr-pickers.projects"]);
  check("projects action exits cleanly", projects.code === 0, projects.stderr.trim());
  await poll("projects picker renders", () => clientBytes() > bytesBeforeProjects ? "rendered" : undefined);
  sendInput(attach, KEY_CTRL_C);
  await Bun.sleep(600);

  const reloadReopened = cli(["plugin", "action", "invoke", "herdr-pickers.workspaces"]);
  check("reload picker exits cleanly", reloadReopened.code === 0, reloadReopened.stderr.trim());
  const bytesBeforeReload = clientBytes();
  sendInput(attach, "\u0012");
  await Bun.sleep(1000);
  check("ctrl-r redraws the picker", clientBytes() > bytesBeforeReload,
    "client output did not grow after ctrl-r");
  sendInput(attach, KEY_ESCAPE);
  await Bun.sleep(600);

  // The adversarial workspace label must never reach the client as a
  // live escape sequence: the sanitizer strips control bytes, so the rendered
  // text may still show inert "]0;pwn" characters, but ESC-prefixed OSC must
  // be absent or the terminal would execute it.
  const rendered = readClientOutput(clientRawPath);
  check("adversarial label is sanitized in render",
    !rendered.includes("\u001b]0;pwn") && !rendered.includes("\u0007two\u001b"),
    "raw OSC payload from the adversarial label reached the client");

  const reopened = cli(["plugin", "action", "invoke", "herdr-pickers.workspaces"]);
  check("reopen picker exits cleanly", reopened.code === 0, reopened.stderr.trim());
  const stableFocus = focusedWorkspaceId();
  sendInput(attach, KEY_ESCAPE);
  await Bun.sleep(800);
  const afterEscape = focusedWorkspaceId();
  check("escape closes without dispatching", afterEscape === stableFocus,
    "focus moved from " + String(stableFocus) + " to " + String(afterEscape));

  writeFileSync(
    join(pluginConfigDir, CONFIG_FILE_NAME),
    `placement = "overlay"\n\n${SMOKE_CONFIG}`,
    "utf8",
  );
  check("no overlay picker exists before opening", listPanes()?.every((pane) => pane.label !== PICKER_PANE_LABEL) === true);
  const overlayOpened = cli(["plugin", "action", "invoke", "herdr-pickers.workspaces"]);
  check("overlay workspaces action exits cleanly", overlayOpened.code === 0, overlayOpened.stderr.trim());
  const overlayPaneId = await waitForOverlayPicker();
  const overlayFocus = focusedWorkspaceId();
  sendInput(attach, KEY_CTRL_C);
  await waitForPaneRemoval("overlay ctrl-c removes the picker pane", overlayPaneId);
  const afterOverlay = focusedWorkspaceId();
  check(
    "overlay ctrl-c closes without dispatching",
    afterOverlay === overlayFocus,
    "focus moved from " + String(overlayFocus) + " to " + String(afterOverlay),
  );

  const overlayEscapeOpened = cli(["plugin", "action", "invoke", "herdr-pickers.workspaces"]);
  check("overlay escape action exits cleanly", overlayEscapeOpened.code === 0, overlayEscapeOpened.stderr.trim());
  const overlayEscapePaneId = await waitForOverlayPicker();
  const overlayEscapeFocus = focusedWorkspaceId();
  sendInput(attach, KEY_ESCAPE);
  await waitForPaneRemoval("overlay escape removes the picker pane", overlayEscapePaneId);
  const afterOverlayEscape = focusedWorkspaceId();
  check(
    "overlay escape closes without dispatching",
    afterOverlayEscape === overlayEscapeFocus,
    "focus moved from " + String(overlayEscapeFocus) + " to " + String(afterOverlayEscape),
  );

  await runOverlayMouseSmoke(repo);

  const secondLogFd = openSync(secondServerLog, "a");
  secondServer = Bun.spawn(["herdr", "--session", SECOND_SESSION_NAME, "server"], {
    env: { ...isolatedEnv(), HERDR_SESSION: SECOND_SESSION_NAME },
    stdin: "ignore",
    stdout: secondLogFd,
    stderr: secondLogFd,
  });
  await verifySessionIsolation(SECOND_SESSION_NAME, SECOND_SESSION_CHECK_PREFIX);
  const secondWorkspace = cliFor(SECOND_SESSION_NAME, [
    "workspace", "create", "--cwd", repo, "--label", SECOND_SESSION_WORKSPACE_LABEL, "--no-focus",
  ]);
  check("second-session workspace creates", secondWorkspace.code === 0, secondWorkspace.stderr.trim());
  const secondClientRaw = openSync(secondClientRawPath, "a");
  secondAttach = Bun.spawn([
    "python3", join(import.meta.dir, "smoke-pty.py"), "herdr", "--session", SECOND_SESSION_NAME,
  ], {
    env: { ...isolatedEnv(), HERDR_SESSION: SECOND_SESSION_NAME, TERM: "xterm-256color" },
    stdin: "pipe",
    stdout: secondClientRaw,
    stderr: "ignore",
  });
  await waitForClientPaint("secondary client paints its first frame", secondClientRawPath);

  const primarySession: SmokeSession = {
    label: "primary session",
    rawOutputPath: clientRawPath,
    run: cli,
    runAsync: (args) => cliAsyncFor(SESSION_NAME, args),
    input: (text) => sendInput(attach, text),
  };
  const secondarySession: SmokeSession = {
    label: "secondary session",
    rawOutputPath: secondClientRawPath,
    run: (args) => cliFor(SECOND_SESSION_NAME, args),
    runAsync: (args) => cliAsyncFor(SECOND_SESSION_NAME, args),
    input: (text) => sendInput(secondAttach, text),
  };
  await runPickerLifecycleSmoke({
    root,
    repo,
    pluginConfigDir,
    baseConfig: SMOKE_CONFIG,
    primary: primarySession,
    secondary: secondarySession,
    firstWorkspaceId: FIRST_WORKSPACE_ID,
    firstWorkspaceLabel: FIRST_WORKSPACE_LABEL,
    dispatchWorkspaceId: DISPATCH_TARGET_WORKSPACE_ID,
    dispatchWorkspaceLabel: DISPATCH_TARGET_WORKSPACE_LABEL,
    check,
    poll,
  });

  for (const [label, sessionName] of [["primary", SESSION_NAME], ["secondary", SECOND_SESSION_NAME]] as const) {
    let pluginEntries: Array<Record<string, unknown> & { status?: string }> = [];
    // Focus events can outlive picker teardown; running hooks are not failed commands.
    await poll(`${label} plugin commands settle`, () => {
      const logs = cliFor(sessionName, ["plugin", "log", "list"]);
      try {
        const parsed = JSON.parse(logs.stdout) as { result?: { logs?: Array<Record<string, unknown> & { status?: string }> } };
        pluginEntries = parsed.result?.logs ?? [];
      } catch { pluginEntries = [{ error: "invalid plugin log response" }]; }
      return pluginEntries.some(entry => entry.status === "running" || entry.status === "queued") ? undefined : "settled";
    });
    const failedEntries = pluginEntries.filter((entry) => entry.status !== "succeeded");
    check(`every ${label} plugin command succeeded`, failedEntries.length === 0, JSON.stringify(failedEntries));
  }

  console.error("smoke passed");
  finish(0);
}

process.on("exit", () => {
  // Belt and braces if finish() was bypassed: only clean up on success.
  if (process.exitCode === 0 || process.exitCode === undefined) {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

main().catch((error: unknown) => {
  console.error(`smoke crashed: ${error instanceof Error ? error.message : String(error)}`);
  finish(1);
});
