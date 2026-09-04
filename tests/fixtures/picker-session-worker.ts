import { PickerSession } from "../../src/picker-session.ts";

const MODE_INDEX = 2;
const OVERLAY_MODE = "overlay";
const UNCLAIMED_MODE = "unclaimed";
const PANE_ID = "w1:p2";

const mode = process.argv[MODE_INDEX];
const session = new PickerSession(process.env);
try {
  const token = await session.reserve(mode === OVERLAY_MODE ? "overlay" : "popup", async () => false);
  if (token && mode !== UNCLAIMED_MODE) session.claim(token, mode === OVERLAY_MODE ? PANE_ID : undefined);
  console.log(JSON.stringify({ token: token ?? null, pid: process.pid }));
  await Bun.stdin.text();
} finally {
  session.close();
}
