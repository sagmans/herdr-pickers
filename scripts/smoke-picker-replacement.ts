import { Database } from "bun:sqlite";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PickerLifecycleSmokeOptions } from "./smoke-picker-lifecycle.ts";
import { hasErrorCode } from "../src/util/objects.ts";

const DATABASE_SETUP = "PRAGMA busy_timeout = 2000";
const OWNER_QUERY = "SELECT session, token, picker, pane, placement FROM owners";
const REQUEST_QUERY = "SELECT token, mode, context, acknowledged FROM requests WHERE session = ?";
const PLUGIN = "herdr-pickers";
const CONFIG_FILE = "config.toml";
const PICKER_LABEL = "Herdr Picker";
const AGENT_LABEL = "smoke-agent";
const AGENT_SOURCE = "picker-replacement-smoke";
const SOURCE_WORKTREE_QUERY = "feature";
const WORKTREE_WORKSPACE = "w2";
const CTRL_C = "\u0003";
const ENTER = "\r";
const READY_MS = 400;
const PROBE_SIGNAL = 0;
const MODES = ["agents", "worktrees", "repo-agents", "all", "projects", "workspaces", "repo-workspaces", "repo-worktrees"] as const;
const STARTUP_MODES = ["workspaces", "projects", "all"] as const;

interface Owner {
  session: string;
  token: string;
  picker: number | null;
  pane: string | null;
  placement: string;
}
interface Request { token: string; mode: string; context: string; acknowledged: string | null }

export async function runPickerReplacementSmoke(options: PickerLifecycleSmokeOptions, path: string): Promise<void> {
  const { primary: session, check, poll } = options;
  const owners = (): Owner[] => {
    const database = new Database(path, { readonly: true });
    try {
      database.exec(DATABASE_SETUP);
      return database.query<Owner, []>(OWNER_QUERY).all();
    } finally { database.close(); }
  };
  const request = (owner: Owner): Request | null => {
    const database = new Database(path, { readonly: true });
    try {
      database.exec(DATABASE_SETUP);
      return database.query<Request, [string]>(REQUEST_QUERY).get(owner.session);
    } finally { database.close(); }
  };
  const invoke = (mode: string) => {
    const result = session.run(["plugin", "action", "invoke", `${PLUGIN}.${mode}`]);
    check(`${mode} replacement invokes`, result.code === 0, result.stderr);
  };
  const alive = (owner: Owner): boolean => {
    if (owner.picker === null) return false;
    try { process.kill(owner.picker, PROBE_SIGNAL); return true; } catch (error) {
      if (hasErrorCode(error, "ESRCH")) return false;
      throw error;
    }
  };
  const readRows = (kind: string): Array<Record<string, unknown>> => {
    const result = session.run([kind, "list"]);
    check(`${kind} list succeeds`, result.code === 0, result.stderr);
    return (JSON.parse(result.stdout) as { result: Record<string, Array<Record<string, unknown>>> }).result[`${kind}s`]!;
  };
  const waitOwner = async (): Promise<Owner> => {
    const serialized = await poll("replacement owner claims", () => {
      const active = owners().filter(alive);
      check("at most one replacement owner", active.length <= 1);
      return active[0] ? JSON.stringify(active[0]) : undefined;
    });
    return JSON.parse(serialized) as Owner;
  };
  const waitAdopted = async (owner: Owner, mode: string, oldRequest?: string): Promise<void> => {
    await poll(`${mode} newest request adopted`, () => {
      const current = request(owner);
      return current?.mode === mode && current.acknowledged === owner.token && current.token !== oldRequest ? current.token : undefined;
    });
  };
  const waitClosed = async (owner: Owner): Promise<void> => {
    await poll("replacement owner exits", () => !alive(owner) ? owner.token : undefined);
    if (owner.pane) await poll("replacement pane removed", () =>
      readRows("pane").some(row => row.pane_id === owner.pane) ? undefined : owner.pane!);
    check("replacement final cleanup completes", true);
  };
  const waitFrame = async (mode: string, offset: number): Promise<void> => {
    const prompt = `${mode.replace("repo-", "repo ")} ›`;
    await poll(`${mode} replacement frame renders`, () =>
      readFileSync(session.rawOutputPath).subarray(offset).toString("utf8").includes(prompt) ? mode : undefined);
  };

  for (const placement of ["popup", "overlay"] as const) {
    writeFileSync(join(options.pluginConfigDir, CONFIG_FILE), `placement = "${placement}"\n\n${options.baseConfig}`);
    const focused = session.run(["worktree", "open", "--cwd", options.repo, "--path", options.repo, "--focus"]);
    check("replacement source opens with repository provenance", focused.code === 0, focused.stderr);
    const sourceWorkspace = readRows("workspace").find(row => row.focused === true)?.workspace_id;
    const sourcePane = readRows("pane").find(row => row.focused === true)?.pane_id;
    check("replacement source pane exists", typeof sourcePane === "string");
    const report = session.run(["pane", "report-agent", String(sourcePane), "--source", AGENT_SOURCE, "--agent", AGENT_LABEL, "--state", "idle"]);
    check("isolated agent fixture registers", report.code === 0, report.stderr);

    const offset = statSync(session.rawOutputPath).size;
    invoke("agents");
    const owner = await waitOwner();
    await waitFrame("agents", offset);
    await Bun.sleep(READY_MS);
    session.input(AGENT_LABEL);
    const alternate = placement === "overlay" ? "popup" : "overlay";
    writeFileSync(join(options.pluginConfigDir, CONFIG_FILE), `placement = "${alternate}"\n\n${options.baseConfig}`);
    for (const mode of MODES) {
      const previous = request(owner)?.token;
      invoke(mode);
      await waitAdopted(owner, mode, previous);
      if (owner.pane) {
        const prompt = `${mode.replace("repo-", "repo ")} ›`;
        await poll(`${mode} overlay frame renders`, () => {
          const frame = session.run(["pane", "read", owner.pane!, "--source", "visible", "--format", "text"]);
          return frame.code === 0 && frame.stdout.includes(prompt) ? mode : undefined;
        });
      } else {
        // Herdr's client emits screen diffs; an unchanged popup prompt has no new byte sequence to match.
        await Bun.sleep(READY_MS);
      }
      const current = owners().find(row => row.session === owner.session);
      check(`${placement} ${mode} keeps owner and surface`, current?.token === owner.token && current.picker === owner.picker && current.pane === owner.pane && current.placement === placement);
      if (owner.pane) {
        check("exactly one overlay remains", readRows("pane").filter(row => row.label === PICKER_LABEL).length === 1);
        const context = JSON.parse(request(owner)!.context) as { workspaceId?: string; paneId?: string };
        check("repository replacement retains original context", context.workspaceId === sourceWorkspace && context.paneId === sourcePane);
      }
    }
    writeFileSync(join(options.pluginConfigDir, CONFIG_FILE), `placement = "${placement}"\n\n${options.baseConfig}`);
    // A real worktree dispatch proves source scope and that the previous agent query was cleared.
    await Bun.sleep(READY_MS);
    session.input(SOURCE_WORKTREE_QUERY);
    await Bun.sleep(READY_MS);
    session.input(ENTER);
    await poll("replacement worktree dispatch focuses its workspace", () =>
      readRows("workspace").find(row => row.focused === true)?.workspace_id === WORKTREE_WORKSPACE ? WORKTREE_WORKSPACE : undefined);
    await waitClosed(owner);

    const burst = await Promise.all(STARTUP_MODES.map(mode => session.runAsync(["plugin", "action", "invoke", `${PLUGIN}.${mode}`])));
    check(`${placement} startup burst invokes`, burst.every(result => result.code === 0));
    const started = await waitOwner();
    invoke("workspaces");
    await waitAdopted(started, "workspaces");
    await Bun.sleep(READY_MS);
    const previous = request(started)?.token;
    // Back-to-back client input and action overlap dismissal without changing the plugin's timing.
    session.input(CTRL_C);
    invoke("workspaces");
    await poll(`${placement} dismissal request survives`, () => {
      const active = owners().find(alive);
      if (!active) return undefined;
      const latest = request(active);
      return latest?.mode === "workspaces" && latest.token !== previous && latest.acknowledged === active.token
        ? latest.token : undefined;
    });
    const successor = await waitOwner();
    if (successor.token !== started.token) check("successor waits for old process exit", !alive(started));
    if (placement === "overlay") check("dismissal leaves one picker pane", readRows("pane").filter(row => row.label === PICKER_LABEL).length === 1);
    await Bun.sleep(READY_MS);
    session.input(options.firstWorkspaceLabel);
    await Bun.sleep(READY_MS);
    session.input(ENTER);
    await poll("dismissal successor dispatches newest request", () =>
      readRows("workspace").find(row => row.focused === true)?.workspace_id === options.firstWorkspaceId ? options.firstWorkspaceId : undefined);
    await waitClosed(successor);
  }
}
