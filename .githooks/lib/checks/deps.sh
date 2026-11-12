#!/usr/bin/env bash
# Generic check: known-vulnerable dependencies with osv-scanner. Copied from
# the shared hook template.
# A lockfile pins what every clone, CI run and release installs, so a pinned
# version with a published advisory must not reach the remote unnoticed.
# Usage: deps.sh <tip-sha> <rev-list args...> (called by lib/checks/push.sh)
# Which commits are scanned:
#   - each pushed commit that changes a lockfile, because each one is a state
#     someone can check out, build or bisect onto;
#   - otherwise the tip once, because advisories are published after the
#     lockfile was last touched.
# A commit whose tree holds no lockfile is skipped without network access.
# Blocks on findings, a missing or old scanner, a scanner or network error,
# a timeout, and an ignore entry in osv-scanner.toml without a reason and an
# end date (a silent, permanent ignore hides the advisory for good).
# Each commit is scanned as a copy of its tracked regular files: osv-scanner
# reads osv-scanner.toml next to each lockfile, so an untracked or ignored one
# in the working tree could hide advisories without review.
# Call analysis stays off. It passes a Go advisory when no scanned code calls
# the affected function, yet that code can gain a caller at any time, and it
# compiles the tree with whatever Go the host has, so one commit could pass on
# one host and fail or report differently on another.

set -euo pipefail

lib_dir="$(cd "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
# shellcheck source-path=SCRIPTDIR source=../tools.sh
. "$lib_dir/tools.sh"
# shellcheck source-path=SCRIPTDIR source=../helpers.sh
. "$lib_dir/helpers.sh"

CHECK=dependency-scan
SCANNER=osv-scanner
SCANNER_MIN_VERSION=2.3.0
INSTALL_HINT='install osv-scanner (https://google.github.io/osv-scanner), e.g. mise use -g osv-scanner or brew install osv-scanner'
# The scanner queries osv.dev; a dead connection must end the push, not hang it.
SCANNER_TIMEOUT_SECONDS=120
# Same result on every host, with no compile step on the pushed tree.
SCANNER_FLAGS=(--no-call-analysis=all)
# Lockfile names osv-scanner reads, matched at any depth.
LOCKFILES=(
    package-lock.json npm-shrinkwrap.json yarn.lock pnpm-lock.yaml bun.lock
    Cargo.lock go.mod
    poetry.lock Pipfile.lock pdm.lock uv.lock requirements.txt
    Gemfile.lock gems.locked composer.lock pubspec.lock mix.lock
    gradle.lockfile buildscript-gradle.lockfile pom.xml packages.lock.json
    conan.lock renv.lock
)
IGNORE_FILE=osv-scanner.toml
# osv-scanner exit codes (see `osv-scanner --help` and its docs).
EXIT_FINDINGS=1
EXIT_TIMEOUT=124
EXIT_NO_PACKAGES=128

tip="${1:?usage: deps.sh <tip-sha> <rev-list args...>}"
shift

tmp="$(mktemp -d "${TMPDIR:-/tmp}/hook-deps.XXXXXX")"
# Only the mktemp directory this run created, never a computed parent.
cleanup() {
    case "$tmp" in
        */hook-deps.*) rm -rf -- "$tmp" ;;
    esac
}
trap cleanup EXIT

# copy_tree <commit> <dir> -- write the commit's regular files into <dir>.
# Symlinks are left out: one could point the scanner outside the copy.
# Lockfiles may refer to sibling files (requirements.txt -r, parent poms), so
# the whole tree is copied, not only the lockfiles.
copy_tree() {
    local commit="$1" dir="$2" entry
    mkdir "$dir"
    GIT_INDEX_FILE="$tmp/index" git read-tree "$commit"
    while IFS= read -r -d '' entry; do
        case "${entry%% *}" in
            100644 | 100755) printf '%s\0' "${entry#*$'\t'}" ;;
        esac
    done < <(git ls-tree -r -z "$commit") |
        GIT_INDEX_FILE="$tmp/index" git checkout-index -z --stdin --prefix="$dir/"
}

# scan_copy <dir> -- run the scanner on the copy; a subshell keeps the cwd.
scan_copy() {
    (cd "$1" && run_with_timeout "$SCANNER_TIMEOUT_SECONDS" "$SCANNER" scan source -r . "${SCANNER_FLAGS[@]}")
}

lock_globs=()
for name in "${LOCKFILES[@]}"; do
    lock_globs+=("*/$name")
done

# tree_paths <commit> <basename>... -- print each path in the commit's tree
# whose file name is one of the names, at any depth.
tree_paths() {
    local commit="$1" path name
    shift
    while IFS= read -r -d '' path; do
        for name in "$@"; do
            if [ "${path##*/}" = "$name" ]; then
                printf '%s\n' "$path"
                break
            fi
        done
    done < <(git ls-tree -r -z --name-only "$commit")
}

# ignore_violations <commit> -- print one line per osv-scanner.toml entry that
# ignores a vulnerability without a reason and an end date. PackageOverrides
# entries count only when they ignore something; license overrides hide no
# advisory.
ignore_violations() {
    local commit="$1" path
    while IFS= read -r path; do
        [ -n "$path" ] || continue
        git show "$commit:$path" | awk -v file="$path" '
            function flush() {
                if (kind != "" && (kind == "IgnoredVulns" || ignores)) {
                    missing = ""
                    if (!reason) missing = "reason"
                    if (!until) missing = missing (missing == "" ? "" : " and ") untilkey
                    if (missing != "") printf "%s:%d: [[%s]] entry needs %s\n", file, start, kind, missing
                }
                kind = ""
            }
            /^[[:space:]]*\[\[[[:space:]]*IgnoredVulns[[:space:]]*\]\]/ {
                flush(); kind = "IgnoredVulns"; untilkey = "ignoreUntil"
                reason = until = ignores = 0; start = NR; next
            }
            /^[[:space:]]*\[\[[[:space:]]*PackageOverrides[[:space:]]*\]\]/ {
                flush(); kind = "PackageOverrides"; untilkey = "effectiveUntil"
                reason = until = ignores = 0; start = NR; next
            }
            /^[[:space:]]*\[PackageOverrides\./ { next }
            /^[[:space:]]*\[/ { flush(); next }
            /^[[:space:]]*(IgnoredVulns|PackageOverrides)[[:space:]]*=/ {
                printf "%s:%d: write each entry as a [[%s]] table so it can be checked\n", file, NR, $1
                next
            }
            kind != "" && /^[[:space:]]*reason[[:space:]]*=/ {
                if ($0 !~ /=[[:space:]]*(""|\047\047)[[:space:]]*(#.*)?$/) reason = 1
            }
            kind != "" && $0 ~ "^[[:space:]]*" untilkey "[[:space:]]*=" { until = 1 }
            kind != "" && /(^|[.[:space:]])ignore[[:space:]]*=[[:space:]]*true/ { ignores = 1 }
            END { flush() }
        '
    done < <(tree_paths "$commit" "$IGNORE_FILE")
}

commits="$(git rev-list "$@")" || {
    echo >&2 "❌ $CHECK: cannot list the pushed commits (try git fetch)"
    exit 1
}
targets=()
for commit in $commits; do
    rc=0
    range_touches "${lock_globs[@]}" -- -n 1 "$commit" || rc=$?
    case "$rc" in
        0) targets+=("$commit") ;;
        1) ;;
        *)
            echo >&2 "❌ $CHECK: cannot list the paths changed by ${commit:0:12}"
            exit 1
            ;;
    esac
done
[ "${#targets[@]}" -gt 0 ] || targets=("$tip")

scanner_ready=0
for target in "${targets[@]}"; do
    [ -n "$(tree_paths "$target" "${LOCKFILES[@]}")" ] || continue

    violations="$(ignore_violations "$target")"
    if [ -n "$violations" ]; then
        echo >&2 "❌ Push rejected: $IGNORE_FILE at ${target:0:12} ignores vulnerabilities without a reason and an end date:"
        printf '%s\n' "$violations" | sed 's/^/   /' >&2
        echo >&2 "   Fix: give each entry reason = \"...\" and ignoreUntil (IgnoredVulns) or effectiveUntil (PackageOverrides)."
        exit 1
    fi

    if [ "$scanner_ready" -eq 0 ]; then
        require_tool "$CHECK" "$SCANNER" "$SCANNER_MIN_VERSION" "$INSTALL_HINT" "$SCANNER" --version
        scanner_ready=1
    fi
    echo "pre-push: $SCANNER at ${target:0:12}"
    copy="$tmp/${target:0:12}"
    copy_tree "$target" "$copy"
    rc=0
    scan_copy "$copy" || rc=$?
    case "$copy" in
        "$tmp"/*) rm -rf -- "$copy" ;;
    esac
    case "$rc" in
        0) ;;
        "$EXIT_FINDINGS")
            echo >&2 "❌ Push rejected: known vulnerabilities in the dependencies at ${target:0:12} (see above)"
            echo >&2 "   Fix: upgrade to a fixed version. Ignore an advisory only in $IGNORE_FILE with reason and ignoreUntil."
            exit 1
            ;;
        "$EXIT_TIMEOUT")
            echo >&2 "❌ Push rejected: $SCANNER did not finish within ${SCANNER_TIMEOUT_SECONDS}s at ${target:0:12}; check the network and push again"
            exit 1
            ;;
        "$EXIT_NO_PACKAGES")
            echo >&2 "❌ Push rejected: $SCANNER read no packages at ${target:0:12}; a lockfile is empty or cannot be parsed (see above)"
            exit 1
            ;;
        *)
            echo >&2 "❌ Push rejected: $SCANNER failed at ${target:0:12} (exit $rc); a network or scanner error is not a pass"
            exit 1
            ;;
    esac
done
