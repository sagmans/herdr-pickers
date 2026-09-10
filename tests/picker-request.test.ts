import { expect, test } from "bun:test";
import { encodeRequestContext, readPickerRequest } from "../src/picker-request.ts";

const VALID = { token: "generation", mode: "worktrees", context: '{"cwd":"/source"}', acknowledged: null } as const;
const TOO_LARGE = "x".repeat(64 * 1024);
const PRIVATE_VALUE = "must-not-persist";
const INVALID = [
  null, {}, { ...VALID, token: "" }, { ...VALID, mode: "unknown" },
  { ...VALID, context: "[]" }, { ...VALID, context: '{"paneId":1}' },
  { ...VALID, context: TOO_LARGE }, { ...VALID, acknowledged: true },
];

test("request parser validates the bounded mode and context boundary", () => {
  expect(readPickerRequest(VALID)).toEqual({ token: VALID.token, mode: VALID.mode, context: { cwd: "/source" }, acknowledgedBy: null });
  for (const value of INVALID) expect(() => readPickerRequest(value)).toThrow();
});

test("request serialization and decoding retain only source context fields", () => {
  const context = { cwd: "/source", AUTH_SECRET: PRIVATE_VALUE };
  const encoded = encodeRequestContext(context);
  expect(encoded).not.toContain(PRIVATE_VALUE);
  expect(readPickerRequest({ ...VALID, context: JSON.stringify(context) }).context).toEqual({ cwd: context.cwd });
});
