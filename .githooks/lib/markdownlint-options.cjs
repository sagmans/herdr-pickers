// Validator for markdownlint-cli2 options files (.markdownlint-cli2.jsonc and
// .markdownlint-cli2.yaml), used by lib/checks/markdown.sh before the linter
// runs. Copied from the shared hook template.
// Declarative options files can still make markdownlint-cli2 load JavaScript
// (customRules, markdownItPlugins, outputFormatters, modulePaths), which would
// run code from the commit inside the hook, and "fix" would repair the
// temporary copy so findings never show. Only the top-level keys below are
// accepted (deny by default), so a key added by a later release is refused
// until it is reviewed.
// The file must parse as JSON with comments and trailing commas, the syntax
// markdownlint-cli2 accepts for .jsonc; a YAML file must use that JSON form,
// because no YAML parser is available here and an unparsed file cannot be
// judged. Any parse error blocks (fail closed).
// Usage: node markdownlint-options.cjs <file>...; prints one line per problem
// and exits 1 when there is any.
"use strict";

const fs = require("node:fs");

// Options with no code loading and no effect on which findings are reported,
// beyond what the reviewed file states (ignores, front matter, inline config).
const ALLOWED_KEYS = new Set([
  "$schema",
  "config",
  "frontMatter",
  "gitignore",
  "globs",
  "ignores",
  "noBanner",
  "noInlineConfig",
  "noProgress",
  "showFound",
]);
const EXIT_PROBLEMS = 1;
const EXIT_USAGE = 2;
const BYTE_ORDER_MARK = "\uFEFF";

// stringEnd returns the index just past the JSON string that opens at i.
function stringEnd(text, i) {
  let j = i + 1;
  while (j < text.length && text[j] !== '"') {
    j += text[j] === "\\" ? 2 : 1;
  }
  return j + 1;
}

// commentEnd returns the index just past the comment that opens at i, or -1
// when no comment opens there.
function commentEnd(text, i) {
  if (text[i] !== "/") return -1;
  if (text[i + 1] === "/") {
    const end = text.indexOf("\n", i);
    return end < 0 ? text.length : end;
  }
  if (text[i + 1] === "*") {
    const end = text.indexOf("*/", i + 2);
    if (end < 0) throw new Error("unterminated block comment");
    return end + 2;
  }
  return -1;
}

// stripJsonc turns JSON with comments into strict JSON: comments become
// spaces (so error positions keep their place) and a comma before a closing
// bracket is dropped. Text inside strings is copied unchanged.
function stripJsonc(text) {
  const out = [];
  let i = 0;
  let pendingComma = -1;
  while (i < text.length) {
    const c = text[i];
    const skip = commentEnd(text, i);
    if (skip >= 0) {
      out.push(text.slice(i, skip).replace(/[^\n]/g, " "));
      i = skip;
      continue;
    }
    if ((c === "}" || c === "]") && pendingComma >= 0) out[pendingComma] = " ";
    if (c === ",") pendingComma = out.length;
    else if (!/\s/.test(c)) pendingComma = -1;
    const next = c === '"' ? stringEnd(text, i) : i + 1;
    out.push(text.slice(i, next));
    i = next;
  }
  return out.join("");
}

// problemsOf returns the reasons one options file is refused.
function problemsOf(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    return [`cannot read the file (${error.code || error.message})`];
  }
  if (text.startsWith(BYTE_ORDER_MARK)) text = text.slice(1);
  let options;
  try {
    options = JSON.parse(stripJsonc(text));
  } catch (error) {
    return [`cannot parse it as JSON with comments (${error.message}); write it in that form`];
  }
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    return ["the top level must be an object"];
  }
  return Object.keys(options)
    .filter((key) => !ALLOWED_KEYS.has(key))
    .map((key) => `key "${key}" is not allowed (allowed: ${[...ALLOWED_KEYS].join(", ")})`);
}

function main(files) {
  if (files.length === 0) {
    process.stderr.write("usage: node markdownlint-options.cjs <file>...\n");
    return EXIT_USAGE;
  }
  let failed = false;
  for (const file of files) {
    for (const problem of problemsOf(file)) {
      process.stdout.write(`${file}: ${problem}\n`);
      failed = true;
    }
  }
  return failed ? EXIT_PROBLEMS : 0;
}

process.exitCode = main(process.argv.slice(2));
