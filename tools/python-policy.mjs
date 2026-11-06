// Keep developer entry points safe when a GUI or hook supplies a minimal PATH.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const GIT_TIMEOUT_MS = 10_000;
const SOURCE_EXTENSIONS = /\.(?:sh|py|mjs|cjs|js|ts)$|(?:^|\/)[^/.]+$/;
const COMMAND_PATTERN = /\bpython(?:3(?:\.\d+)?)?\s+(?:-(?:[cm]\b|(?=\s|$))|[\w./-]+\.py\b)/;
const SPAWN_PATTERN =
  /\b(?:spawn|spawnSync|execFile|execFileSync|run|Popen|call|check_call|check_output)\s*\(\s*(?:\[\s*)?['"]python(?:3)?['"]/;
const SHEBANG_PATTERN = /^#!.*\bpython(?:3(?:\.\d+)?)?(?:\s|$)/;
const MANAGED_COMMAND = "uv run --no-project --python-preference only-managed python";
const PACKAGE_PATH = "package.json";
const GUARD_PATH = "tools/python-policy.mjs";
const FAILURE_MESSAGE = "Python entry points must use uv with only-managed preference";

// Read tracked sources only, so installed dependencies cannot affect this gate.
const paths = execFileSync("git", ["ls-files", "-z"], {
  encoding: "utf8",
  timeout: GIT_TIMEOUT_MS,
})
  .split("\0")
  .filter(Boolean);
const failures = [];
for (const path of paths) {
  if (path === GUARD_PATH || !(SOURCE_EXTENSIONS.test(path) || path === PACKAGE_PATH)) continue;
  const lines = readFileSync(path, "utf8").split("\n");
  for (const [index, line] of lines.entries()) {
    if (line.trimStart().startsWith("#") && !line.startsWith("#!")) continue;
    // Remove each approved command before inspection, so another call cannot hide beside it.
    const unwrapped = line.replaceAll(MANAGED_COMMAND, "managed-runtime");
    if (!COMMAND_PATTERN.test(unwrapped) && !SPAWN_PATTERN.test(unwrapped) && !SHEBANG_PATTERN.test(unwrapped))
      continue;
    failures.push(`${path}:${index + 1}`);
  }
}
if (failures.length) {
  console.error(`${FAILURE_MESSAGE}\n${failures.join("\n")}`);
  process.exitCode = 1;
} else {
  console.log("Python entry-point policy passed");
}
