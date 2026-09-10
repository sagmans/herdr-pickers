// Host safety: every herdr process and CLI call runs with all four XDG base
// dirs redirected into a temp root, so config, sessions, sockets, and plugin
// state never touch the host installation. The script aborts before any
// mutation unless the session socket is verified to live under the temp root.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { runPickerLifecycleSmoke, type CliResult, type SmokeSession } from "./smoke-picker-lifecycle.ts";

const PLUGIN_ROOT = join(import.meta.dir, "..");
const PLUGIN_ID = "herdr-pickers";
const CONFIG_FILE_NAME = "config.toml";
const SMOKE_CONFIG = '[keymap]\nup = ["up", "ctrl-k"]\ndown = ["down", "ctrl-j"]\n';
const KEY_CTRL_C = "\u0003";
const KEY_CTRL_J = "\u000a";
const KEY_ENTER = "\r";
const KEY_ESCAPE = "\u001b";
const KEY_INPUT_SETTLE_MS = 100;
const PICKER_PANE_LABEL = "Herdr Picker";
const OVERLAY_PICKER_PROMPT = "workspaces › ";
const SMOKE_QUERY = "smoke-";
const FIRST_WORKSPACE_ID = "w1";
const FIRST_WORKSPACE_LABEL = "smoke-one";
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
const POLL_INTERVAL_MS = 150;
const POLL_TIMEOUT_MS = 15_000;

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
  env.XDG_CONFIG_HOME = join(root, "x");
  env.XDG_STATE_HOME = join(root, "s");
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

async function poll(label: string, probe: () => string | undefined): Promise<string> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) { check(label, false, "timed out"); return ""; }
    await Bun.sleep(POLL_INTERVAL_MS);
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
  for (const proc of [attach, secondAttach]) {
    if (!proc) continue;
    try { proc.kill(); } catch { /* already gone */ }
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
    const pane = listPanes()?.find((pane) => pane.label === PICKER_PANE_LABEL && pane.focused === true);
    if (!pane) return undefined;
    const output = cli(["pane", "read", pane.pane_id, "--source", "visible", "--format", "text"]);
    return output.code === 0 && output.stdout.includes(OVERLAY_PICKER_PROMPT) ? pane.pane_id : undefined;
  });
}

async function waitForPaneRemoval(label: string, paneId: string): Promise<void> {
  await poll(label, () => listPanes()?.some((pane) => pane.pane_id === paneId) === false ? paneId : undefined);
  check(label, true);
}

function focusedWorkspaceId(): string | undefined {
  const result = cli(["workspace", "list"]);
  if (result.code !== 0) return undefined;
  try {
    const parsed = JSON.parse(result.stdout) as { result?: { workspaces?: Array<{ workspace_id?: string; focused?: boolean }> } };
    return parsed.result?.workspaces?.find((workspace) => workspace.focused)?.workspace_id;
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  console.error(`smoke root: ${root}`);
  mkdirSync(fixtureRoot, { recursive: true });

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
  await Bun.sleep(2500);
  // Focus history is what last-workspace toggles through: seed one
  // transition (w1 -> w2) so the later picker dispatch (-> w3) records w2
  // as the previous workspace.
  const seeded = cli(["workspace", "focus", "w2"]);
  check("focus transition seeds last-workspace memory", seeded.code === 0, seeded.stderr.trim());
  await Bun.sleep(1000);

  const opened = cli(["plugin", "action", "invoke", "herdr-pickers.workspaces"]);
  check("workspaces action exits cleanly", opened.code === 0, opened.stderr.trim());
  const before = focusedWorkspaceId();
  // Wait for the popup to render because earlier keys route to the focused
  // shell pane instead of the picker.
  await Bun.sleep(1500);
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
  const rendered = readFileSync(clientRawPath, "latin1");
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
  await Bun.sleep(2500);

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
