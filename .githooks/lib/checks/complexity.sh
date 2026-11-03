#!/usr/bin/env bash
# Generic check: function complexity with lizard. Copied from the shared
# hook template.
# A function with many branches or many lines is hard to review and to test,
# and it grows one small change at a time; this stops the growth at the push
# that makes it.
# Usage: complexity.sh <tip-sha> <rev-list args...> (called by lib/checks/push.sh)
# Judges only functions the push changes: a function at the tip whose lines
# include at least one line the pushed commits wrote (git blame over the same
# range). Complex code the push does not touch never blocks, so a repo can
# adopt the check before it pays off old debt. A push that only deletes lines
# inside a function does not judge it.
# Thresholds: MAX_CCN and MAX_LENGTH below; a repo may change them in a root
# .lizard-thresholds file, with a written reason for each value (see README).

set -euo pipefail

lib_dir="$(cd "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
# shellcheck source-path=SCRIPTDIR source=../tools.sh
. "$lib_dir/tools.sh"

CHECK=complexity
SCANNER=lizard
SCANNER_MIN_VERSION=1.24.1
INSTALL_HINT='install lizard (https://github.com/terryyin/lizard), e.g. mise use -g pipx:lizard or uv tool install lizard'
# Cyclomatic complexity: lizard's own default warning level.
MAX_CCN=15
# Lines from the function's first to its last line, comments included.
MAX_LENGTH=100
OVERRIDE_FILE=.lizard-thresholds
# Keys the override file may set; each needs a matching <key>_reason line.
OVERRIDE_KEYS=' ccn length '
# File types lizard parses; other files are skipped before blame runs.
SCANNED_EXTENSIONS=' c h cc cpp cxx hh hpp hxx m mm java cs js jsx mjs cjs ts tsx py rb php swift scala go lua rs kt kts sol erl zig vue pl pm r gd f90 f95 f03 '
# --root: the first commit of a new history counts as written by the push.
# Empty --ignore-revs-file: a repo blame config must not hide pushed commits.
BLAME_ARGS=(--line-porcelain --root --ignore-revs-file=)
# The porcelain header of each blamed line: "<commit> <orig-line> <line>".
# 40 hex characters in a SHA-1 repository, 64 in a SHA-256 one; a header
# that did not match would drop every changed line and pass the push.
BLAME_HEADER_RE='^[0-9a-f]{40}([0-9a-f]{24})? [0-9]+ [0-9]+'

tip="${1:?usage: complexity.sh <tip-sha> <rev-list args...>}"
shift
rev_args=("$@")

tmp="$(mktemp -d "${TMPDIR:-/tmp}/hook-complexity.XXXXXX")"
# Only the mktemp directory this run created, never a computed parent.
cleanup() {
    case "$tmp" in
        */hook-complexity.*) rm -rf -- "$tmp" ;;
    esac
}
trap cleanup EXIT

if ! range_changed_paths "${rev_args[@]}" >"$tmp/paths"; then
    echo >&2 "❌ $CHECK: cannot list the paths changed by the push (try git fetch)"
    exit 1
fi

# Keep the parsed file types that still exist at the tip.
files=()
while IFS= read -r -d '' path; do
    [ -n "$path" ] || continue
    name="${path##*/}"
    has_extension "$name" "$SCANNED_EXTENSIONS" || continue
    git cat-file -e "$tip:$path" 2>/dev/null || continue
    files+=("$path")
done <"$tmp/paths"
[ "${#files[@]}" -gt 0 ] || exit 0

require_tool "$CHECK" "$SCANNER" "$SCANNER_MIN_VERSION" "$INSTALL_HINT" "$SCANNER" --version

# The override is read from the tip, the state the remote will hold.
max_ccn="$MAX_CCN"
max_length="$MAX_LENGTH"
if git cat-file -e "$tip:$OVERRIDE_FILE" 2>/dev/null; then
    reasons=' '
    values=' '
    lineno=0
    while IFS= read -r line || [ -n "$line" ]; do
        lineno=$((lineno + 1))
        [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
        if ! [[ "$line" =~ ^([a-z]+)(_reason)?=(.*)$ ]] || [[ "$OVERRIDE_KEYS" != *" ${BASH_REMATCH[1]} "* ]]; then
            echo >&2 "❌ Push rejected: $OVERRIDE_FILE:$lineno: unknown setting; allowed: ccn, length and <key>_reason"
            exit 1
        fi
        key="${BASH_REMATCH[1]}"
        value="${BASH_REMATCH[3]}"
        if [ -n "${BASH_REMATCH[2]}" ]; then
            [[ "$value" =~ [^[:space:]] ]] && reasons+="$key "
            continue
        fi
        if ! [[ "$value" =~ ^[1-9][0-9]{0,3}$ ]]; then
            echo >&2 "❌ Push rejected: $OVERRIDE_FILE:$lineno: $key must be a whole number from 1 to 9999"
            exit 1
        fi
        values+="$key "
        case "$key" in
            ccn) max_ccn="$value" ;;
            length) max_length="$value" ;;
        esac
    done < <(git cat-file blob "$tip:$OVERRIDE_FILE")
    for key in $values; do
        if [[ "$reasons" != *" $key "* ]]; then
            echo >&2 "❌ Push rejected: $OVERRIDE_FILE sets $key without a reason"
            echo >&2 "   Fix: add a line ${key}_reason=<why this repo needs another value>."
            exit 1
        fi
    done
fi

# changed_lines <path> -- print the tip line numbers the pushed commits wrote.
# Lines blame puts on a boundary commit were already on the remote.
changed_lines() {
    git blame "${BLAME_ARGS[@]}" "${rev_args[@]}" -- "$1" | awk -v header="$BLAME_HEADER_RE" '
        $0 ~ header { line = $3; boundary = 0; next }
        /^boundary$/ { boundary = 1; next }
        /^\t/ { if (!boundary) print line }
    '
}

# Each judged file goes to its own numbered directory, so a lizard report line
# maps back to the repo path whatever characters the path holds. The copy is
# named with the lower-case extension, because lizard picks the language by
# extension and does not know .PY.
lizard_inputs=()
for i in "${!files[@]}"; do
    path="${files[$i]}"
    if ! changed_lines "$path" >"$tmp/lines.$i"; then
        echo >&2 "❌ $CHECK: git blame failed on $path at ${tip:0:12} (try git fetch)"
        exit 1
    fi
    [ -s "$tmp/lines.$i" ] || continue
    mkdir -p "$tmp/blobs/n$i"
    copy="$tmp/blobs/n$i/source.$(lower_extension "$path")"
    git cat-file blob "$tip:$path" >"$copy"
    lizard_inputs+=("$copy")
done
[ "${#lizard_inputs[@]}" -gt 0 ] || exit 0

echo "pre-push: $SCANNER (CCN ≤ $max_ccn, length ≤ $max_length)"
# --no-gitignore: every input is a tracked file the push changed.
if ! report="$("$SCANNER" --csv --no-gitignore "${lizard_inputs[@]}" 2>"$tmp/stderr")"; then
    echo >&2 "❌ Push rejected: $SCANNER failed at ${tip:0:12}; a scanner error is not a pass"
    sed 's/^/   /' "$tmp/stderr" >&2
    exit 1
fi

# CSV: nloc,ccn,tokens,params,length,"location","file","function","long_name",start,end
csv_re='^[0-9]+,([0-9]+),[0-9]+,[0-9]+,([0-9]+),"(.*)",([0-9]+),([0-9]+)$'
findings=()
while IFS= read -r row; do
    [ -n "$row" ] || continue
    if ! [[ "$row" =~ $csv_re ]]; then
        echo >&2 "❌ Push rejected: cannot read a $SCANNER report line: $row"
        exit 1
    fi
    ccn="${BASH_REMATCH[1]}"
    length="${BASH_REMATCH[2]}"
    middle="${BASH_REMATCH[3]}"
    start="${BASH_REMATCH[4]}"
    end="${BASH_REMATCH[5]}"
    [ "$ccn" -gt "$max_ccn" ] || [ "$length" -gt "$max_length" ] || continue
    [[ "$middle" =~ /blobs/n([0-9]+)/ ]] || continue
    i="${BASH_REMATCH[1]}"
    # Only a function that holds a line the push wrote is judged.
    awk -v s="$start" -v e="$end" '$1 >= s && $1 <= e { found = 1; exit } END { exit !found }' "$tmp/lines.$i" || continue
    function_name="${middle%%@"$start-$end"@*}"
    problems=''
    [ "$ccn" -le "$max_ccn" ] || problems="CCN $ccn > $max_ccn"
    if [ "$length" -gt "$max_length" ]; then
        problems="${problems:+$problems, }length $length > $max_length lines"
    fi
    findings+=("${files[$i]}:$start: $function_name: $problems")
done <<<"$report"

if [ "${#findings[@]}" -gt 0 ]; then
    echo >&2 "❌ Push rejected: the push changes functions that are too complex at ${tip:0:12}:"
    printf '   %s\n' "${findings[@]}" >&2
    cat >&2 <<GUIDANCE
   Fix: split each function into smaller ones (extract branches and steps
   into named helpers), then rewrite the commits. To change a threshold for
   this repo, set it in a root $OVERRIDE_FILE with a <key>_reason line.
GUIDANCE
    exit 1
fi
