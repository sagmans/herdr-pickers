import { Herdr } from "../client/herdr.ts";
import { readPickerPaneIds } from "../client/types.ts";
import { PICKER_TOKEN_ENV, PickerSession } from "../picker-session.ts";
import { PICKER_REQUEST_POLL_MS, PICKER_REQUEST_TIMEOUT_MS } from "../picker-request.ts";
import { CURRENT_CONTEXT_ENV, currentContextFromEnv } from "../catalog.ts";
import { loadConfig, type PickerPlacement } from "../config/config.ts";
import { parseMode, type PickerMode } from "../picker.ts";
import { formatPaneError } from "../pane.ts";

const MODE_ENV = "HERDR_PICKERS_MODE";
const DELIVERY_FAILURE = "Picker request could not be delivered before the deadline. Reopen after the current picker closes.";

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
  herdr?: Herdr,
): Promise<void> {
  const pluginId = env.HERDR_PLUGIN_ID;
  if (!pluginId) throw new Error("HERDR_PLUGIN_ID is required to open the herdr-pickers pane.");

  const config = loadConfig(env);
  const session = new PickerSession(env);
  const cancellation = new AbortController();
  const client = herdr ?? new Herdr({ signal: cancellation.signal });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(DELIVERY_FAILURE);
      cancellation.abort(error);
      reject(error);
    }, PICKER_REQUEST_TIMEOUT_MS);
  });
  try {
    const request = session.request(mode, currentContextFromEnv(env));
    const deliver = async () => {
      let opened = false;
      while (true) {
        cancellation.signal.throwIfAborted();
        const latest = session.latestRequest();
        if (latest?.token !== request.token || latest.acknowledgedBy !== null) return;
        if (!opened) {
          const token = await session.reserve(config.placement, async paneId => {
            const panes = await client.json(["pane", "list"]);
            cancellation.signal.throwIfAborted();
            return readPickerPaneIds(panes).includes(paneId);
          });
          cancellation.signal.throwIfAborted();
          if (token) {
            // Even a superseded opener must launch its reserved child; the child reads the newest request.
            opened = true;
            await client.run(buildPaneOpenArgs({ pluginId, mode, env, placement: config.placement, token }));
          }
        }
        cancellation.signal.throwIfAborted();
        await Bun.sleep(PICKER_REQUEST_POLL_MS);
      }
    };
    await Promise.race([deliver(), expired]);
  } finally {
    clearTimeout(timer);
    cancellation.abort();
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