import { Herdr, HerdrCommandError, HerdrSpawnError } from "../client/herdr.ts";
import { readPickerPaneIds } from "../client/types.ts";
import { PICKER_TOKEN_ENV, PickerSession, PickerStartupUncertainError } from "../picker-session.ts";
import { PICKER_REQUEST_POLL_MS, PICKER_REQUEST_TIMEOUT_MS } from "../picker-request.ts";
import { currentContextFromEnv } from "../context.ts";
import { loadConfig, type PickerPlacement } from "../config/config.ts";
import { parseMode, type PickerMode } from "../modes.ts";
import { formatPaneError } from "../pane.ts";

const MODE_ENV = "HERDR_PICKERS_MODE";
const DELIVERY_FAILURE = "Picker request could not be delivered before the deadline. Reopen after the current picker closes.";

export function buildPaneOpenArgs(options: {
  readonly pluginId: string;
  readonly mode: PickerMode;
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
    // Source context travels in the picker request, not the pane environment,
    // so a replacement keeps the original source without respawning the pane.
    "--env",
    `${MODE_ENV}=${options.mode}`,
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
          }).catch(error => {
            // A submitted child can claim after its opener exits; waiting never authorizes a duplicate.
            if (error instanceof PickerStartupUncertainError) return undefined;
            throw error;
          });
          cancellation.signal.throwIfAborted();
          if (token) {
            // Even a superseded opener must launch its reserved child; the child reads the newest request.
            opened = true;
            try {
              await client.run(buildPaneOpenArgs({ pluginId, mode, placement: config.placement, token }));
            } catch (error) {
              // A spawn failure or an explicit Herdr refusal proves no child holds this
              // token; transport loss and aborts stay reserved until the grace period ends.
              if (error instanceof HerdrSpawnError || error instanceof HerdrCommandError) session.releaseUnsubmitted(token);
              throw error;
            }
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

if (import.meta.main) {
  Promise.resolve().then(() => openPicker(parseMode(process.argv[2]))).catch((error: unknown) => {
    console.error(formatPaneError(error));
    process.exit(1);
  });
}