#!/usr/bin/env bash
# Generic check: static analysis (SAST) with semgrep and the vendored rules in
# lib/semgrep/. Copied from the shared hook template.
# Code and command injection, unsafe deserialization and downloads piped to a
# shell are easy to add by accident and hard to spot in review; this blocks
# the common forms before they reach the remote.
# Usage: sast.sh <tip-sha> <rev-list args...> (called by lib/checks/push.sh)
# Scans only the files the push changes that still exist at the tip, copied
# from the tip commit into a temporary tree: semgrep reads .semgrepignore
# from the directory it scans, so a file in the working tree could hide code.
# No network: local rules only, metrics and the version check off. A tracked
# .semgrepignore at the tip replaces semgrep's default ignores (tests/,
# vendor/, node_modules/, ...) only when each pattern has a reason comment
# above it. Inline nosemgrep comments still work. A repo that runs a full
# semgrep of its own still runs this one; the overlap costs seconds and keeps
# every repo at the same floor.

set -euo pipefail

lib_dir="$(cd "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
# shellcheck source-path=SCRIPTDIR source=../tools.sh
. "$lib_dir/tools.sh"

CHECK=sast
SCANNER=semgrep
SCANNER_MIN_VERSION=1.182.0
INSTALL_HINT='install semgrep (https://semgrep.dev/docs/getting-started/), e.g. brew install semgrep or uv tool install semgrep'
RULES_DIR="$lib_dir/semgrep"
# File types the vendored rules cover. Extensionless files are kept because
# scripts often have no extension; semgrep reads their shebang.
SCANNED_EXTENSIONS=' js jsx mjs cjs ts tsx mts cts py go sh bash dockerfile '
DOCKERFILE_PREFIX=Dockerfile
# A repo relaxes the scan only through this tracked file, read from the tip.
IGNORE_FILE=.semgrepignore
EXIT_FINDINGS=1

tip="${1:?usage: sast.sh <tip-sha> <rev-list args...>}"
shift

tmp="$(mktemp -d "${TMPDIR:-/tmp}/hook-sast.XXXXXX")"
# Only the mktemp directory this run created, never a computed parent.
cleanup() {
    case "$tmp" in
        */hook-sast.*) rm -rf -- "$tmp" ;;
    esac
}
trap cleanup EXIT
paths_file="$tmp/paths"

if ! range_changed_paths "$@" >"$paths_file"; then
    echo >&2 "❌ $CHECK: cannot list the paths changed by the push (try git fetch)"
    exit 1
fi

# Keep the scanned file types that still exist at the tip as regular files
# (a deleted file has nothing left to scan; a symlink could point outside).
targets=()
while IFS= read -r -d '' path; do
    [ -n "$path" ] || continue
    name="${path##*/}"
    case "$name" in
        "$DOCKERFILE_PREFIX"*) ;;
        *.*) has_extension "$name" "$SCANNED_EXTENSIONS" || continue ;;
    esac
    targets+=("$path")
done <"$paths_file"
[ "${#targets[@]}" -gt 0 ] || exit 0

require_tool "$CHECK" "$SCANNER" "$SCANNER_MIN_VERSION" "$INSTALL_HINT" "$SCANNER" --version

tree="$tmp/tree"
mkdir "$tree"

# A private index of the tip writes the files with their exec bit, which
# semgrep needs to read a script's shebang.
regular=()
while IFS= read -r -d '' entry; do
    mode="${entry%% *}"
    case "$mode" in
        100644 | 100755) regular+=("${entry#*$'\t'}") ;;
    esac
done < <(git --literal-pathspecs ls-tree -z "$tip" -- "${targets[@]}")
[ "${#regular[@]}" -gt 0 ] || exit 0
GIT_INDEX_FILE="$tmp/index" git read-tree "$tip"
printf '%s\0' "${regular[@]}" | GIT_INDEX_FILE="$tmp/index" git checkout-index -z --stdin --prefix="$tree/"
# semgrep skips an extension it does not know in that letter case (C.JS), so
# such a copy gets the lower-case extension appended; findings then name
# <path>.<ext>, which still points at the file.
for path in "${regular[@]}"; do
    name="${path##*/}"
    [[ "$name" == *.* ]] || continue
    lower="$(lower_extension "$name")"
    [ "${name##*.}" != "$lower" ] || continue
    if [ -e "$tree/$path.$lower" ]; then
        echo >&2 "❌ $CHECK: cannot scan $path: $path.$lower exists too; rename one of them"
        exit 1
    fi
    mv -- "$tree/$path" "$tree/$path.$lower"
done

# Each ignore pattern needs a reason on the line above it. ":include" would
# pull in another file whose patterns carry no reason, so it is refused.
if git cat-file -e "$tip:$IGNORE_FILE" 2>/dev/null; then
    git cat-file blob "$tip:$IGNORE_FILE" >"$tree/$IGNORE_FILE"
    missing="$(awk '
        /^[[:space:]]*$/ { reason = 0; next }
        /^[[:space:]]*#/ { reason = ($0 ~ /^[[:space:]]*#[[:space:]]*[^[:space:]]/); next }
        /^:/ || !reason { printf "%d ", NR }
        { reason = 0 }
    ' "$tree/$IGNORE_FILE")"
    if [ -n "$missing" ]; then
        echo >&2 "❌ Push rejected: $IGNORE_FILE at ${tip:0:12} skips paths without a reason (lines: ${missing% })"
        echo >&2 "   Fix: put a '# why this path needs no scan' comment above each pattern; :include is not allowed."
        exit 1
    fi
fi

# --emacs: one line per finding with the short rule id. The default text
# report prefixes each id with the rules path and wraps it at the terminal
# width, so a long checkout path splits the id across lines.
run_semgrep() {
    echo "pre-push: $SCANNER (vendored rules)"
    (cd "$tree" && SEMGREP_SEND_METRICS=off SEMGREP_ENABLE_VERSION_CHECK=0 \
        "$SCANNER" scan --config "$RULES_DIR" --metrics=off --disable-version-check \
        --severity ERROR --error --quiet --emacs .)
}

rc=0
run_semgrep || rc=$?
case "$rc" in
    0) ;;
    "$EXIT_FINDINGS")
        echo >&2 "❌ Push rejected: static analysis found unsafe code at ${tip:0:12} (see above)"
        echo >&2 "   Fix the findings as each message says; the rules are in .githooks/lib/semgrep/."
        exit 1
        ;;
    *)
        echo >&2 "❌ Push rejected: $SCANNER failed at ${tip:0:12} (exit $rc); a scanner error is not a pass"
        exit 1
        ;;
esac
