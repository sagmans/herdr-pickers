import { Herdr } from "../client/herdr.ts";
import { readPickerPaneIds } from "../client/types.ts";
import { PICKER_TOKEN_ENV, PickerSession } from "../picker-session.ts";
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
  readonly token?: string;
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
    ...(options.token ? ["--env", `${PICKER_TOKEN_ENV}=${options.token}`] : []),
  ];
}

export async function openPicker(
  mode: PickerMode,
  env: Record<string, string | undefined> = process.env,
  herdr: Herdr = new Herdr(),
): Promise<void> {
  const pluginId = env.HERDR_PLUGIN_ID;
  if (!pluginId) throw new Error("HERDR_PLUGIN_ID is required to open the herdr-pickers pane.");

  const config = loadConfig(env);
  const session = new PickerSession(env);
  try {
    const token = await session.reserve(config.placement, async paneId =>
      readPickerPaneIds(await herdr.json(["pane", "list"])).includes(paneId));
    if (!token) return;
    await herdr.run(buildPaneOpenArgs({ pluginId, mode, env, placement: config.placement, token }));
  } finally {
    session.close();
  }
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
  Promise.resolve().then(() => openPicker(parseMode(process.argv[2]))).catch((error: unknown) => {
    console.error(formatPaneError(error));
    process.exit(1);
  });
}