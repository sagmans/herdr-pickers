#!/usr/bin/env bash
# shellcheck shell=bash
# Shared helpers for the generic checks that call an external scanner
# (markdownlint-cli2, actionlint, zizmor, osv-scanner, semgrep). Copied from
# the shared hook template.
# Every such check must fail closed in the same way: a missing or too old
# binary blocks with an install hint, because a scan that did not run is not
# a scan that passed. Keeping that logic here stops each check from growing
# its own slightly different copy.

# require_tool <check> <binary> <min-version> <install-hint> <version-cmd...>
# Fail unless <binary> is on PATH and its version (the first dotted number in
# the output of <version-cmd>) is at least <min-version>. Old releases miss
# rules or flags the checks rely on, so they cannot be trusted to pass.
require_tool() {
    local check="$1" binary="$2" min="$3" hint="$4" out version
    shift 4
    if ! command -v "$binary" >/dev/null 2>&1; then
        echo >&2 "❌ $check: $binary not found; $hint"
        return 1
    fi
    # Some tools print their version with a non-zero status (for example
    # markdownlint-cli2 --help), so only the text is judged.
    out="$("$@" 2>&1 || true)"
    if ! [[ "$out" =~ ([0-9]+(\.[0-9]+)+) ]]; then
        echo >&2 "❌ $check: cannot read the $binary version from '$*'"
        return 1
    fi
    version="${BASH_REMATCH[1]}"
    if ! version_ge "$version" "$min"; then
        echo >&2 "❌ $check: $binary $version is older than the minimum $min; $hint"
        return 1
    fi
}

# has_extension <file-name> <list> -- true when the extension of the name is
# in the space-padded list, in any letter case. Tools on Windows and macOS
# often write .JS or .PY, and a file skipped for its case is code no scanner
# saw. Leaves the caller's nocasematch setting as it was.
has_extension() {
    local name="$1" list="$2" was=0 rc=1
    [[ "$name" == *.* ]] || return 1
    shopt -q nocasematch && was=1
    shopt -s nocasematch
    [[ "$list" == *" ${name##*.} "* ]] && rc=0
    [ "$was" -eq 1 ] || shopt -u nocasematch
    return "$rc"
}

# lower_extension <file-name> -- print its extension in lower case. Scanners
# pick a file's language from its extension, case-sensitively, so a copy
# handed to them needs the lower-case form.
lower_extension() {
    printf '%s' "${1##*.}" | LC_ALL=C tr '[:upper:]' '[:lower:]'
}

# version_ge <a> <b> -- true when dotted version <a> >= <b>. Pure bash, because
# `sort -V` is missing from some BSD and busybox builds.
version_ge() {
    local IFS=. i
    # shellcheck disable=SC2206  # split on dots on purpose
    local -a a=($1) b=($2)
    for ((i = 0; i < ${#a[@]} || i < ${#b[@]}; i++)); do
        if ((10#${a[i]:-0} > 10#${b[i]:-0})); then return 0; fi
        if ((10#${a[i]:-0} < 10#${b[i]:-0})); then return 1; fi
    done
    return 0
}

# run_with_timeout <seconds> <cmd...>
# Run a command that talks to the network and stop it when it hangs, so a
# dead connection blocks the push with a clear message instead of freezing
# it. Plain bash, because GNU timeout is not installed on stock macOS.
# Returns the command's status, or 124 on timeout (as GNU timeout does).
run_with_timeout() {
    local seconds="$1" pid watcher rc=0 flag
    shift
    flag="$(mktemp "${TMPDIR:-/tmp}/hook-timeout.XXXXXX")" || return 1
    "$@" &
    pid=$!
    # The watcher polls once a second, so after the command ends it lives at
    # most one more second. It must not hold the caller's stdout or stderr
    # open, or a caller that captures output would wait for it.
    (
        waited=0
        while [ "$waited" -lt "$seconds" ]; do
            sleep 1
            kill -0 "$pid" 2>/dev/null || exit 0
            waited=$((waited + 1))
        done
        echo timeout >"$flag"
        kill -TERM "$pid" 2>/dev/null
    ) </dev/null >/dev/null 2>&1 &
    watcher=$!
    wait "$pid" || rc=$?
    kill "$watcher" 2>/dev/null || true
    wait "$watcher" 2>/dev/null || true
    # 143 is death by TERM; only that, with the flag, is our timeout.
    if [ "$rc" -eq 143 ] && [ -s "$flag" ]; then
        rc=124
    fi
    # Only the mktemp file this call created.
    case "$flag" in
        */hook-timeout.*) rm -f -- "$flag" ;;
    esac
    return "$rc"
}

# range_changed_paths <rev-list args...>
# Print, NUL-separated and once each, every path that a commit in the range
# adds, changes or deletes; readers skip the one empty entry that the blank
# log format leaves. pre-push checks use it to skip a scan when the push does
# not touch what the scanner looks at. NUL, because a path may hold any byte
# but NUL. Callers run with pipefail, so a git failure is not an empty list.
# A merge is compared with its first parent: git log shows no paths for a
# merge by default, so a file added only while resolving it would skip every
# scan.
range_changed_paths() {
    git log --format= --name-only --no-renames --diff-merges=first-parent -z "$@" | LC_ALL=C sort -zu
}

# range_touches <glob>... -- <rev-list args...>
# Return 0 when a commit in the range adds, changes or deletes a path that
# matches one of the globs, 1 when none does, 2 when git fails (callers must
# block on 2). Globs match "/<path>", so "*/go.mod" finds go.mod at any depth
# and "/.github/workflows/*" only at the top.
range_touches() {
    local globs=() list path glob rc=1
    while [ "$#" -gt 0 ] && [ "$1" != -- ]; do
        globs+=("$1")
        shift
    done
    shift
    list="$(mktemp "${TMPDIR:-/tmp}/hook-paths.XXXXXX")" || return 2
    if range_changed_paths "$@" >"$list"; then
        while IFS= read -r -d '' path; do
            [ -n "$path" ] || continue
            for glob in "${globs[@]}"; do
                # shellcheck disable=SC2053  # the glob must match as a pattern
                if [[ "/$path" == $glob ]]; then
                    rc=0
                    break 2
                fi
            done
        done <"$list"
    else
        rc=2
    fi
    # Only the mktemp file this call created.
    case "$list" in
        */hook-paths.*) rm -f -- "$list" ;;
    esac
    return "$rc"
}
