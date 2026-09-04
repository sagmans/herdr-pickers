import { Herdr } from "../client/herdr.ts";
import { CURRENT_CONTEXT_ENV, currentContextFromEnv } from "../catalog.ts";
import { loadConfig, type PickerPlacement } from "../config/config.ts";
import { parseMode, type PickerMode } from "../picker.ts";
import { formatPaneError } from "../pane.ts";

const MODE_ENV = "HERDR_PICKERS_MODE";

export function buildPaneOpenArgs(options: {
  readonly pluginId: string;
  readonly mode: PickerMode;
  readonly env?: Record<string, string | undefined> | undefined;
  readonly placement?: PickerPlacement;
}): string[] {
  // Overlay must be requested here: manifest size applies only to popup.
  // Width and height flags are omitted because overlay rejects them.
  return [
    "plugin",
    "pane",
    "open",
    "--plugin",
    options.pluginId,
    "--entrypoint",
    "picker",
    ...(options.placement === "overlay" ? ["--placement", "overlay"] : []),
    ...paneEnvArgs(options.mode, options.env),
  ];
}

async function run(): Promise<void> {
  const pluginId = process.env.HERDR_PLUGIN_ID;
  if (!pluginId) throw new Error("HERDR_PLUGIN_ID is required to open the herdr-pickers pane.");

  const mode = parseMode(process.argv[2]);
  const config = loadConfig(process.env);
  await new Herdr().run(buildPaneOpenArgs({
    pluginId,
    mode,
    env: process.env,
    placement: config.placement,
  }));
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