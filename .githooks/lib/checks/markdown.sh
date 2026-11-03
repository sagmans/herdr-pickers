#!/usr/bin/env bash
# Generic check: markdownlint-cli2 on the staged Markdown files. Copied from
# the shared hook template.
# Docs are read on hosting sites and by agents; broken lists, headings and
# fences render wrong there, so a commit must not add them.
# Lints what is committed, not the worktree: the staged blobs are written to
# a temporary tree that keeps their repo-relative paths, so a partly staged
# file is judged by its staged half and messages name the real paths.
# Config: the repo's own declarative markdownlint config files, read from the
# same index (a root .markdownlint.jsonc may extend the base, see
# lib/markdownlint.jsonc); without a root rules file the base applies.
# markdownlint-cli2 options files can still load JavaScript through some
# keys, so each one must pass lib/markdownlint-options.cjs first, with node.
# Nothing staged: exits after one git call, without needing the binary.

set -euo pipefail

# shellcheck source-path=SCRIPTDIR source=../tools.sh
. "$(dirname -- "${BASH_SOURCE[0]}")/../tools.sh"

CHECK=markdownlint
LINTER=markdownlint-cli2
LINTER_MIN_VERSION=0.23.2
INSTALL_HINT='install markdownlint-cli2 (https://github.com/DavidAnson/markdownlint-cli2), e.g. mise use -g npm:markdownlint-cli2 or brew install markdownlint-cli2'
# Both Markdown extensions, in any letter case: a README.MD or notes.markdown
# renders as Markdown on hosting sites too.
MARKDOWN_PATHSPECS=(':(icase)*.md' ':(icase)*.markdown')
# Regular files only: a symlink or submodule has no Markdown text of its own.
REGULAR_MODES=' 100644 100755 '
# Names markdownlint-cli2 discovers per directory. JavaScript configs would
# run code from the commit inside the hook, so they are refused, not loaded.
RULES_CONFIGS=' .markdownlint.jsonc .markdownlint.json .markdownlint.yaml .markdownlint.yml '
CLI2_CONFIGS=' .markdownlint-cli2.jsonc .markdownlint-cli2.yaml '
CONFIG_PATHSPEC='*.markdownlint*'
BASE_CONFIG_NAME=markdownlint.jsonc
ROOT_RULES_FILE=.markdownlint.jsonc
OPTIONS_VALIDATOR_NAME=markdownlint-options.cjs
NODE_HINT='install Node.js (https://nodejs.org), which markdownlint-cli2 needs too'

index="${PROJECT_HOOK_INDEX_FILE:?markdown.sh: run from the pre-commit hook}"

# git runs pre-commit at the worktree top, so index paths resolve from here.
files=()
while IFS= read -r -d '' meta && IFS= read -r -d '' path; do
    # --raw meta: ":<old mode> <new mode> <old sha> <new sha> <status>"
    read -r _ mode _ <<<"$meta"
    [[ "$REGULAR_MODES" == *" $mode "* ]] && files+=("$path")
done < <(GIT_INDEX_FILE="$index" git diff --cached --raw -z --no-renames --diff-filter=ACM -- "${MARKDOWN_PATHSPECS[@]}")
[ "${#files[@]}" -gt 0 ] || exit 0

require_tool "$CHECK" "$LINTER" "$LINTER_MIN_VERSION" "$INSTALL_HINT" "$LINTER" --help

lib_dir="$(cd "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
top="$(cd "$(git rev-parse --show-toplevel)" && pwd -P)"
cd "$top"

configs=()
cli2_configs=()
has_root_rules=0
while IFS= read -r -d '' path; do
    name="${path##*/}"
    case "$name" in
        .markdownlint*.cjs | .markdownlint*.mjs | .markdownlint*.js)
            echo >&2 "❌ $CHECK: $path is a JavaScript config; the hook runs only declarative configs (.jsonc, .json, .yaml)"
            exit 1
            ;;
    esac
    if [[ "$RULES_CONFIGS$CLI2_CONFIGS" == *" $name "* ]]; then
        configs+=("$path")
        [[ "$path" == "$name" && "$RULES_CONFIGS" == *" $name "* ]] && has_root_rules=1
        [[ "$CLI2_CONFIGS" == *" $name "* ]] && cli2_configs+=("$path")
    fi
done < <(GIT_INDEX_FILE="$index" git ls-files -z -- "$CONFIG_PATHSPEC")

tmp="$(mktemp -d "${TMPDIR:-/tmp}/hook-markdown.XXXXXX")"
# Only the mktemp directory this run created, never a computed parent.
cleanup() {
    case "$tmp" in
        */hook-markdown.*) rm -rf -- "$tmp" ;;
    esac
}
trap cleanup EXIT

tree="$tmp/tree"
mkdir "$tree"
printf '%s\0' "${files[@]}" ${configs[@]+"${configs[@]}"} |
    GIT_INDEX_FILE="$index" git checkout-index -z --stdin --prefix="$tree/"

# The staged copies are judged, never the worktree files. node is the
# runtime markdownlint-cli2 itself needs; without it nothing can be judged.
if [ "${#cli2_configs[@]}" -gt 0 ]; then
    if ! command -v node >/dev/null 2>&1; then
        echo >&2 "❌ $CHECK: node not found; it is needed to check ${cli2_configs[*]}; $NODE_HINT"
        exit 1
    fi
    if ! problems="$(cd "$tree" && node "$lib_dir/$OPTIONS_VALIDATOR_NAME" "${cli2_configs[@]}" 2>&1)"; then
        echo >&2 "❌ Commit rejected — a markdownlint-cli2 options file is not allowed:"
        printf '%s\n' "$problems" | sed 's/^/   /' >&2
        echo >&2 "   Fix: keep only declarative options; custom rules, plugins and formatters would run code from the commit."
        exit 1
    fi
fi

# The base sits where the repo sees it, so a repo config that extends
# .githooks/lib/markdownlint.jsonc resolves in the temporary tree too.
case "$lib_dir" in
    "$top"/*)
        mkdir -p "$tree/${lib_dir#"$top"/}"
        cp "$lib_dir/$BASE_CONFIG_NAME" "$tree/${lib_dir#"$top"/}/$BASE_CONFIG_NAME"
        ;;
esac
if [ "$has_root_rules" -eq 0 ]; then
    cp "$lib_dir/$BASE_CONFIG_NAME" "$tree/$ROOT_RULES_FILE"
fi

# ":" makes each argument a literal path, so a name with glob characters is
# linted as itself; --no-globs stops a repo config from adding other files.
args=()
for path in "${files[@]}"; do
    args+=(":$path")
done
if ! report="$(cd "$tree" && "$LINTER" --no-globs "${args[@]}" 2>&1)"; then
    echo >&2 "❌ Commit rejected — Markdown lint failed on the staged files:"
    # Drop the banner lines; keep every finding and error.
    printf '%s\n' "$report" | { grep -v -e '^markdownlint-cli2 v' -e '^Finding: ' -e '^Linting: ' || true; } | sed 's/^/   /' >&2
    cat >&2 <<'GUIDANCE'
   Fix: correct the lines above (markdownlint-cli2 --fix <file> repairs many),
   then stage the files again. To relax a rule for this repo, extend
   .githooks/lib/markdownlint.jsonc in a root .markdownlint.jsonc and write
   the reason next to the rule.
GUIDANCE
    exit 1
fi
