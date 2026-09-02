import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "bun:test";

import { canonicalPathKey, isPathWithin } from "../src/util/paths.ts";

const TEMP_PREFIX = "herdr-pickers-paths-";

test("canonicalPathKey resolves symlinks and missing paths", () => {
  const root = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
  const target = join(root, "target");
  const link = join(root, "link");
  mkdirSync(target);
  symlinkSync(target, link);

  expect(canonicalPathKey(link)).toBe(realpathSync(target));
  expect(canonicalPathKey(join(root, "missing"))).toBe(resolve(root, "missing"));
});

test("isPathWithin matches ancestry on canonical paths", () => {
  const root = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
  const inner = join(root, "src", "deep");
  mkdirSync(inner, { recursive: true });
  const link = join(root, "link");
  symlinkSync(root, link);

  expect(isPathWithin(root, root)).toBe(true);
  expect(isPathWithin(root, inner)).toBe(true);
  expect(isPathWithin(link, inner)).toBe(true);
  expect(isPathWithin(inner, root)).toBe(false);
  expect(isPathWithin(join(root, "prefix-sibling"), inner)).toBe(false);
});
