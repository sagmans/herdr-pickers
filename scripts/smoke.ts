// PTY smoke: proves the plugin inside a real, disposable Herdr runtime.
// Host safety: every herdr process and CLI call runs with all four XDG base
// dirs redirected into a temp root, so config, sessions, sockets, and plugin
// state never touch the host installation. The script aborts before any
// mutation unless the session socket is verified to live under the temp root.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PLUGIN_ROOT = join(import.meta.dir, "..");
const PLUGIN_ID = "herdr-pickers";
const CONFIG_FILE_NAME = "config.toml";
const SMOKE_CONFIG = '[keymap]\nup = ["up", "ctrl-k"]\ndown = ["down", "ctrl-j"]\n';
const KEY_CTRL_C = "\u0003";
const KEY_CTRL_J = "\u000a";
const KEY_ENTER = "\r";
const KEY_ESCAPE = "\u001b";
const KEY_INPUT_SETTLE_MS = 100;
const SMOKE_QUERY = "smoke-";
const DISPATCH_TARGET_WORKSPACE_ID = "w3";
const SESSION_NAME = `s-${Date.now().toString(36)}`;
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
const clientRawPath = join(root, "client.raw");

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

function cli(args: readonly string[]): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync("herdr", [...args], {
      env: { ...isolatedEnv(), HERDR_SESSION: SESSION_NAME },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout, stderr: "" };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { code: failure.status ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

const checks: Array<[label: string, ok: boolean, detail?: string]> = [];
function check(label: string, ok: boolean, detail?: string): void {
  checks.push([label, ok, detail]);
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

let server: Bun.Subprocess<"ignore", "file", "file"> | undefined;
let attach: Bun.Subprocess<"pipe", "ignore", "ignore"> | undefined;

function finish(code: number): never {
  if (code !== 0) console.error(`keeping smoke root for inspection: ${root}`);
  for (const proc of [attach, server]) {
    if (!proc) continue;
    try { proc.kill(); } catch { /* already gone */ }
  }
  cli(["plugin", "unlink", "herdr-pickers"]);
  cli(["session", "stop", SESSION_NAME]);
  cli(["session", "delete", SESSION_NAME]);
  if (code === 0) {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  process.exit(code);
}

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
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
  execFileSync("mkdir", ["-p", fixtureRoot]);

  // 1. headless server under the isolated config
  const logFd = openSync(serverLog, "a");
  server = Bun.spawn(["herdr", "--session", SESSION_NAME, "server"], {
    env: { ...isolatedEnv(), HERDR_SESSION: SESSION_NAME },
    stdin: "ignore",
    stdout: logFd,
    stderr: logFd,
  });

  await poll("server becomes ready", () => {
    const listed = cli(["pane", "list"]);
    return listed.code === 0 ? "ready" : undefined;
  });

  // 2. isolation proof BEFORE any mutation: socket/session dir must live under root.
  const status = cli(["status", "server"]);
  check("runtime is isolated under temp config", status.stdout.includes(root),
    `unexpected socket path in: ${status.stdout.trim()}`);

  // 3. fixture repository with a linked worktree
  const repo = join(fixtureRoot, "sample-repo");
  execFileSync("mkdir", ["-p", repo]);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "smoke@example.invalid");
  git(repo, "config", "user.name", "smoke");
  // The host's global signing config must not leak into throwaway fixtures.
  git(repo, "config", "commit.gpgsign", "false");
  git(repo, "commit", "-q", "--allow-empty", "-m", "fixture");
  git(repo, "worktree", "add", "-q", join(fixtureRoot, "sample-repo-wt"), "-b", "feature");

  // 4. three workspaces: the first takes the initial focus (herdr focuses the
  // only workspace at creation time), eviltwo carries an adversarial label,
  // and smoke-two is the dispatch target the picker must focus.
  const created = cli(["workspace", "create", "--cwd", repo, "--label", "smoke-one", "--no-focus"]);
  check("workspace create succeeds", created.code === 0, created.stderr.trim());
  const adversarialLabel = "evil\u001B]0;pwn\u0007two\u2066";
  const createdTwo = cli(["workspace", "create", "--cwd", join(fixtureRoot, "sample-repo-wt"), "--label", adversarialLabel, "--no-focus"]);
  check("adversarial workspace create succeeds", createdTwo.code === 0, createdTwo.stderr.trim());
  const createdThree = cli(["workspace", "create", "--cwd", repo, "--label", "smoke-two", "--no-focus"]);
  check("dispatch-target workspace create succeeds", createdThree.code === 0, createdThree.stderr.trim());

  // 5. link the plugin inside the isolated runtime only
  const linked = cli(["plugin", "link", PLUGIN_ROOT, "--enabled"]);
  check("plugin links", linked.code === 0, linked.stderr.trim());
  const configDirResult = cli(["plugin", "config-dir", PLUGIN_ID]);
  check("plugin config directory resolves", configDirResult.code === 0, configDirResult.stderr.trim());
  const pluginConfigDir = configDirResult.stdout.trim();
  check("plugin config remains isolated", pluginConfigDir.startsWith(root), pluginConfigDir);
  mkdirSync(pluginConfigDir, { recursive: true });
  writeFileSync(join(pluginConfigDir, CONFIG_FILE_NAME), SMOKE_CONFIG, "utf8");

  // 6. all nine actions register
  const actions = cli(["plugin", "action", "list", "--plugin", "herdr-pickers"]);
  let registered: string[] = [];
  try {
    const parsed = JSON.parse(actions.stdout) as { result?: { actions?: Array<{ action_id?: string }> } };
    registered = (parsed.result?.actions ?? []).map((action) => action.action_id ?? "").sort();
  } catch { /* handled by check */ }
  check("all nine actions register", JSON.stringify(registered) === JSON.stringify([...ACTION_IDS].sort()),
    `registered: ${registered.join(", ")}`);

  // 7. attach a client through a real PTY bridge so popups have a terminal
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

  // 8. open the workspaces picker and dispatch with configured Ctrl-J navigation
  const opened = cli(["plugin", "action", "invoke", "herdr-pickers.workspaces"]);
  check("workspaces action exits cleanly", opened.code === 0, opened.stderr.trim());
  const before = focusedWorkspaceId();
  // Wait for the popup to render because earlier keys route to the focused
  // shell pane instead of the picker.
  await Bun.sleep(1500);
  attach.stdin.write(SMOKE_QUERY);
  await Bun.sleep(400);
  attach.stdin.write(KEY_CTRL_J);
  await Bun.sleep(KEY_INPUT_SETTLE_MS);
  // CR keeps acceptance distinct from Ctrl-J's indistinguishable LF byte.
  attach.stdin.write(KEY_ENTER);
  const configuredSelection = await poll("configured ctrl-j selection", () => {
    const focused = focusedWorkspaceId();
    return focused === DISPATCH_TARGET_WORKSPACE_ID ? focused : undefined;
  });
  check(
    "configured ctrl-j dispatches the next selection",
    configuredSelection === DISPATCH_TARGET_WORKSPACE_ID,
    configuredSelection,
  );

  // 9. last-workspace toggles back
  const toggled = cli(["plugin", "action", "invoke", "herdr-pickers.last-workspace"]);
  check("last-workspace action exits cleanly", toggled.code === 0, toggled.stderr.trim());
  await poll("last-workspace restores the previous focus", () => {
    const focused = focusedWorkspaceId();
    return focused === before ? focused : undefined;
  });

  // 10. Discovery action registers a real catalog without touching host state
  const bytesBeforeProjects = clientBytes();
  const projects = cli(["plugin", "action", "invoke", "herdr-pickers.projects"]);
  check("projects action exits cleanly", projects.code === 0, projects.stderr.trim());
  await poll("projects picker renders", () => clientBytes() > bytesBeforeProjects ? "rendered" : undefined);
  attach.stdin.write(KEY_CTRL_C);
  await Bun.sleep(600);

  // 11. Ctrl-r reloads an open picker without breaking it
  const reloadReopened = cli(["plugin", "action", "invoke", "herdr-pickers.workspaces"]);
  check("reload picker exits cleanly", reloadReopened.code === 0, reloadReopened.stderr.trim());
  const bytesBeforeReload = clientBytes();
  attach.stdin.write("\u0012");
  await Bun.sleep(1000);
  check("ctrl-r redraws the picker", clientBytes() > bytesBeforeReload,
    "client output did not grow after ctrl-r");
  attach.stdin.write(KEY_ESCAPE);
  await Bun.sleep(600);

  // 12. The adversarial workspace label must never reach the client as a
  // live escape sequence: the sanitizer strips control bytes, so the rendered
  // text may still show inert "]0;pwn" characters, but ESC-prefixed OSC must
  // be absent or the terminal would execute it.
  const rendered = readFileSync(clientRawPath, "latin1");
  check("adversarial label is sanitized in render",
    !rendered.includes("\u001b]0;pwn") && !rendered.includes("\u0007two\u001b"),
    "raw OSC payload from the adversarial label reached the client");

  // 13. Escape closes an open picker without dispatching, and a fresh open still works
  const reopened = cli(["plugin", "action", "invoke", "herdr-pickers.workspaces"]);
  check("reopen picker exits cleanly", reopened.code === 0, reopened.stderr.trim());
  const stableFocus = focusedWorkspaceId();
  attach.stdin.write(KEY_ESCAPE);
  await Bun.sleep(800);
  const afterEscape = focusedWorkspaceId();
  check("escape closes without dispatching", afterEscape === stableFocus,
    "focus moved from " + String(stableFocus) + " to " + String(afterEscape));

  // Overlay is a real zoomed pane: prove open and Ctrl-C restore focus.
  writeFileSync(
    join(pluginConfigDir, CONFIG_FILE_NAME),
    `placement = "overlay"\n\n${SMOKE_CONFIG}`,
    "utf8",
  );
  const bytesBeforeOverlay = clientBytes();
  const overlayOpened = cli(["plugin", "action", "invoke", "herdr-pickers.workspaces"]);
  check("overlay workspaces action exits cleanly", overlayOpened.code === 0, overlayOpened.stderr.trim());
  await poll("overlay picker renders", () => clientBytes() > bytesBeforeOverlay ? "rendered" : undefined);
  const overlayFocus = focusedWorkspaceId();
  attach.stdin.write(KEY_CTRL_C);
  await Bun.sleep(800);
  const afterOverlay = focusedWorkspaceId();
  check(
    "overlay ctrl-c closes without dispatching",
    afterOverlay === overlayFocus,
    "focus moved from " + String(overlayFocus) + " to " + String(afterOverlay),
  );

  // 11. plugin command log shows no failures
  const logs = cli(["plugin", "log", "list"]);
  let pluginEntries: Array<Record<string, unknown> & { status?: string }> = [];
  try {
    const parsed = JSON.parse(logs.stdout) as { result?: { logs?: Array<Record<string, unknown> & { status?: string }> } };
    pluginEntries = parsed.result?.logs ?? [];
  } catch { pluginEntries = [{ error: "invalid plugin log response" }]; }
  const failedEntries = pluginEntries.filter((entry) => entry.status !== "succeeded");
  check("every plugin command succeeded", failedEntries.length === 0, JSON.stringify(failedEntries));

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
