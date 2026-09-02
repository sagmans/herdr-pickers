import { Herdr } from "../client/herdr.ts";
import { CURRENT_CONTEXT_ENV, currentContextFromEnv } from "../catalog.ts";
import { parseMode, type PickerMode } from "../picker.ts";
import { formatPaneError } from "../pane.ts";

const MODE_ENV = "HERDR_PICKERS_MODE";

export function buildPaneOpenArgs(options: { readonly pluginId: string; readonly mode: PickerMode; readonly env?: Record<string, string | undefined> | undefined }): string[] {
  // Placement and sizing live in the manifest (popup at 75% x 75%): the CLI
  // has no width/height flags and its --placement enum predates popup. No
  // --focus either: popups receive all terminal input on their own.
  return [
    "plugin",
    "pane",
    "open",
    "--plugin",
    options.pluginId,
    "--entrypoint",
    "picker",
    ...paneEnvArgs(options.mode, options.env),
  ];
}

async function run(): Promise<void> {
  const pluginId = process.env.HERDR_PLUGIN_ID;
  if (!pluginId) throw new Error("HERDR_PLUGIN_ID is required to open the herdr-pickers pane.");

  const mode = parseMode(process.argv[2]);
  await new Herdr().run(buildPaneOpenArgs({ pluginId, mode, env: process.env }));
}

function paneEnvArgs(mode: PickerMode, env: Record<string, string | undefined> | undefined): string[] {
  const current = currentContextFromEnv(env);
  const entries: Array<readonly [string, string | undefined]> = [
    [MODE_ENV, mode],
    [CURRENT_CONTEXT_ENV.workspaceId, current.workspaceId],
    [CURRENT_CONTEXT_ENV.tabId, current.tabId],
    [CURRENT_CONTEXT_ENV.paneId, current.paneId],
    [CURRENT_CONTEXT_ENV.cwd, current.cwd],
  ];
  return entries.flatMap(([key, value]) => value ? ["--env", `${key}=${value}`] : []);
}

if (import.meta.main) {
  run().catch((error: unknown) => {
    console.error(formatPaneError(error));
    process.exit(1);
  });
}