import { Herdr, HerdrCommandError, HerdrSpawnError } from "../client/herdr.ts";
import { readPickerPaneIds } from "../client/types.ts";
import {
  PICKER_REQUEST_POLL_MS, PICKER_REQUEST_TIMEOUT_MS, PICKER_TOKEN_ENV, PickerSession, PickerStartupUncertainError,
} from "../picker-session.ts";
import { currentContextFromEnv } from "../context.ts";
import { loadConfig, type PickerPlacement } from "../config/config.ts";
import { parseMode, type PickerMode } from "../modes.ts";
import { formatErrorBlock } from "../util/errors.ts";

const DELIVERY_FAILURE = "Picker request could not be delivered before the deadline. Reopen after the current picker closes.";

export function buildPaneOpenArgs(options: {
  readonly pluginId: string;
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
    // Mode and source context travel in the picker request, not the pane
    // environment, so a replacement switches mode without respawning the pane.
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
  const deadline = AbortSignal.timeout(PICKER_REQUEST_TIMEOUT_MS);
  const cancellation = new AbortController();
  const signal = AbortSignal.any([cancellation.signal, deadline]);
  const client = herdr ?? new Herdr({ signal });
  const paneExists = async (paneId: string): Promise<boolean> => {
    const panes = await client.json(["pane", "list"]);
    signal.throwIfAborted();
    return readPickerPaneIds(panes).includes(paneId);
  };
  const launch = async (token: string): Promise<void> => {
    try {
      await client.run(buildPaneOpenArgs({ pluginId, placement: config.placement, token }));
    } catch (error) {
      // A spawn failure or an explicit Herdr refusal proves no child holds this
      // token; transport loss and aborts stay reserved until the grace period ends.
      if (error instanceof HerdrSpawnError || error instanceof HerdrCommandError) session.releaseUnsubmitted(token);
      throw error;
    }
  };
  try {
    const request = session.request(mode, currentContextFromEnv(env));
    let launched = false;
    // Delivery ends when a picker acknowledges this request or a newer one supersedes it.
    while (isUndelivered(session, request.token)) {
      if (!launched) {
        const token = await untilAborted(session.reserve(config.placement, paneExists).catch(error => {
          // A submitted child can claim after its opener exits; waiting never authorizes a duplicate.
          if (error instanceof PickerStartupUncertainError) return undefined;
          throw error;
        }), signal);
        if (token) {
          // Even a superseded opener must launch its reserved child; the child reads the newest request.
          launched = true;
          await untilAborted(launch(token), signal);
        }
      }
      await untilAborted(Bun.sleep(PICKER_REQUEST_POLL_MS), signal);
    }
  } catch (error) {
    // Whatever was in flight at the deadline, the user-facing cause is the deadline.
    if (deadline.aborted) throw new Error(DELIVERY_FAILURE);
    throw error;
  } finally {
    cancellation.abort();
    session.close();
  }
}

function isUndelivered(session: PickerSession, token: string): boolean {
  const latest = session.latestRequest();
  return latest?.token === token && latest.acknowledgedBy === null;
}

/** Stops waiting at the deadline even when an injected or stalled operation ignores the signal. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

if (import.meta.main) {
  Promise.resolve().then(() => openPicker(parseMode(process.argv[2]))).catch((error: unknown) => {
    console.error(formatErrorBlock(error));
    process.exit(1);
  });
}