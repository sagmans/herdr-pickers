#!/usr/bin/env bash
# Generic check: GitHub Actions workflow scan with actionlint and zizmor.
# Copied from the shared hook template.
# Workflows run with repository secrets and write tokens, so a broken or
# injectable workflow is a supply-chain risk once it reaches the remote.
# actionlint finds syntax, expression and shell errors; zizmor finds security
# problems (unpinned actions, template injection, credential persistence).
# Usage: workflows.sh <tip-sha> <rev-list args...> (called by lib/checks/push.sh)
# Runs only when the pushed range touches a file the scan reads (anything
# under .github, an action.yml at any depth, or a scanner config), and scans the workflow and action files of the tip commit, copied into a
# temporary tree: both scanners read config files from the directory they
# scan, so a file in the working tree could hide findings. The configs are the
# hook's own (lib/zizmor.yml, lib/actionlint.yaml), passed explicitly; a
# tracked repo config at the tip replaces one only when each relaxation has a
# reason comment above it.
# zizmor runs offline: online audits need a GitHub token and the network, and
# a push gate must not depend on either. Persona "regular" keeps false
# positives low; every severity blocks.

set -euo pipefail

lib_dir="$(cd "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
# shellcheck source-path=SCRIPTDIR source=../tools.sh
. "$lib_dir/tools.sh"

CHECK=workflow-scan
ACTIONLINT_MIN_VERSION=1.7.7
ZIZMOR_MIN_VERSION=1.14.1
ACTIONLINT_HINT='install actionlint (https://github.com/rhysd/actionlint), e.g. mise use -g actionlint or brew install actionlint'
ZIZMOR_HINT='install zizmor (https://docs.zizmor.sh), e.g. mise use -g zizmor or brew install zizmor'
WORKFLOW_DIR=.github/workflows
ZIZMOR_PERSONA=regular
# Tracked repo configs that may replace a base config, read from the tip.
ZIZMOR_REPO_CONFIGS=(zizmor.yml zizmor.yaml .github/zizmor.yml .github/zizmor.yaml)
ZIZMOR_BASE_CONFIG="$lib_dir/zizmor.yml"
ACTIONLINT_REPO_CONFIGS=(.github/actionlint.yaml .github/actionlint.yml)
ACTIONLINT_BASE_CONFIG="$lib_dir/actionlint.yaml"
# A repo zizmor config replaces the base one, so it must keep a pinning
# policy of its own (with its reason) rather than drop the base floor.
ZIZMOR_REQUIRED_RULE=unpinned-uses
# Keep scanner inputs scoped to .github and action definitions anywhere;
# local-action sibling files outside .github are not copied. Globs match "/<path>".
TREE_GLOBS=('/.github/*' '*/action.yml' '*/action.yaml')
# The scan runs when the push changes a file it would read, so the triggers
# come from the same lists: a change it skipped would reach the remote
# unscanned.
SCAN_TRIGGERS=("${TREE_GLOBS[@]}")
for config in "${ZIZMOR_REPO_CONFIGS[@]}" "${ACTIONLINT_REPO_CONFIGS[@]}"; do
    SCAN_TRIGGERS+=("/$config")
done

tip="${1:?usage: workflows.sh <tip-sha> <rev-list args...>}"
shift

rc=0
range_touches "${SCAN_TRIGGERS[@]}" -- "$@" || rc=$?
case "$rc" in
    0) ;;
    1) exit 0 ;;
    *)
        echo >&2 "❌ $CHECK: cannot list the paths changed by the push (try git fetch)"
        exit 1
        ;;
esac

require_tool "$CHECK" actionlint "$ACTIONLINT_MIN_VERSION" "$ACTIONLINT_HINT" actionlint -version
require_tool "$CHECK" zizmor "$ZIZMOR_MIN_VERSION" "$ZIZMOR_HINT" zizmor --version

tmp="$(mktemp -d "${TMPDIR:-/tmp}/hook-workflows.XXXXXX")"
# Only the mktemp directory this run created, never a computed parent.
cleanup() {
    case "$tmp" in
        */hook-workflows.*) rm -rf -- "$tmp" ;;
    esac
}
trap cleanup EXIT

# repo_config <name>... -- print the one tracked config of these names at
# the tip, or nothing; two of them would leave it unclear which one applies.
repo_config() {
    local name found=''
    for name in "$@"; do
        git cat-file -e "$tip:$name" 2>/dev/null || continue
        if [ -n "$found" ]; then
            echo >&2 "❌ Push rejected: both $found and $name exist at ${tip:0:12}; keep one"
            return 1
        fi
        found="$name"
    done
    printf '%s' "$found"
}

# YAML features that could pull settings from elsewhere in the file and slip
# past the line checks below: anchors, aliases and merge keys.
YAML_INDIRECTION_RE='(^|[[:space:]:,[{-])[&*][A-Za-z0-9_]|<<[[:space:]]*:'

# zizmor_violations <file> -- print one line per problem: only a top-level
# "rules:" block, a reason comment above each rule entry, and the pinning
# rule present.
zizmor_violations() {
    awk -v required="$ZIZMOR_REQUIRED_RULE" -v indirection="$YAML_INDIRECTION_RE" '
        function indent_of(line) { match(line, /^ */); return RLENGTH }
        /^[[:space:]]*$/ { reason = 0; next }
        /^[[:space:]]*#/ { reason = ($0 ~ /^[[:space:]]*#[[:space:]]*[^[:space:]]/); next }
        $0 ~ indirection { printf "line %d: anchors, aliases and merge keys are not allowed\n", NR; reason = 0; next }
        {
            ind = indent_of($0)
            if (ind == 0) {
                if ($0 !~ /^rules:[[:space:]]*(#.*)?$/) printf "line %d: only a block-style top-level rules: key is allowed\n", NR
                else in_rules = 1
            } else if (!in_rules) {
                printf "line %d: content outside rules:\n", NR
            } else {
                if (!child) child = ind
                if (ind < child) printf "line %d: unexpected indentation\n", NR
                else if (ind == child) {
                    if ($0 !~ /^ *[A-Za-z0-9_-]+:[[:space:]]*(#.*)?$/) printf "line %d: write each rule as a block-style key\n", NR
                    else {
                        name = $0; sub(/^ */, "", name); sub(/:.*/, "", name)
                        if (name == required) seen = 1
                        if (!reason) printf "line %d: rule %s needs a reason comment on the line above\n", NR, name
                    }
                }
            }
            reason = 0
        }
        END { if (!seen) printf "the %s rule must stay (copy it from the base config, with its reason)\n", required }
    ' "$1"
}

# actionlint_violations <file> -- print one line per entry of an ignore:
# list without a reason comment on the line above.
actionlint_violations() {
    awk -v indirection="$YAML_INDIRECTION_RE" '
        function indent_of(line) { match(line, /^ */); return RLENGTH }
        /^[[:space:]]*$/ { reason = 0; next }
        /^[[:space:]]*#/ { reason = ($0 ~ /^[[:space:]]*#[[:space:]]*[^[:space:]]/); next }
        $0 ~ indirection { printf "line %d: anchors, aliases and merge keys are not allowed\n", NR; reason = 0; next }
        {
            ind = indent_of($0)
            if (in_ignore && (ind > ignore_indent || (ind == ignore_indent && $0 ~ /^ *- /))) {
                if ($0 ~ /^ *- / && !reason) printf "line %d: ignore entry needs a reason comment on the line above\n", NR
            } else {
                in_ignore = 0
                if ($0 ~ /^ *(- +)?ignore:/) {
                    if ($0 !~ /^ *(- +)?ignore:[[:space:]]*(#.*)?$/) printf "line %d: write ignore: as a block list\n", NR
                    else { in_ignore = 1; ignore_indent = ind }
                }
            }
            reason = 0
        }
    ' "$1"
}

# Copy the workflow and action files of the tip, regular files only (a
# symlink could point outside), without any repo scanner config: configs are
# passed explicitly below.
files=()
while IFS= read -r -d '' entry; do
    mode="${entry%% *}"
    path="${entry#*$'\t'}"
    case "$mode" in 100644 | 100755) ;; *) continue ;; esac
    for config in "${ZIZMOR_REPO_CONFIGS[@]}" "${ACTIONLINT_REPO_CONFIGS[@]}"; do
        [ "$path" = "$config" ] && continue 2
    done
    for glob in "${TREE_GLOBS[@]}"; do
        # shellcheck disable=SC2053  # the glob must match as a pattern
        if [[ "/$path" == $glob ]]; then
            files+=("$path")
            break
        fi
    done
done < <(git ls-tree -r -z "$tip")
tree="$tmp/tree"
mkdir "$tree"
if [ "${#files[@]}" -gt 0 ]; then
    GIT_INDEX_FILE="$tmp/index" git read-tree "$tip"
    printf '%s\0' "${files[@]}" | GIT_INDEX_FILE="$tmp/index" git checkout-index -z --stdin --prefix="$tree/"
fi
# actionlint finds the project root, and with it local actions, by .git; an
# empty template keeps the user's init hooks out.
git init -q --template= "$tree"

zizmor_config="$ZIZMOR_BASE_CONFIG"
actionlint_config="$ACTIONLINT_BASE_CONFIG"
name="$(repo_config "${ZIZMOR_REPO_CONFIGS[@]}")" || exit 1
if [ -n "$name" ]; then
    git cat-file blob "$tip:$name" >"$tmp/zizmor.yml"
    problems="$(zizmor_violations "$tmp/zizmor.yml")"
    if [ -n "$problems" ]; then
        echo >&2 "❌ Push rejected: $name at ${tip:0:12} relaxes zizmor without a reason:"
        printf '%s\n' "$problems" | sed 's/^/   /' >&2
        exit 1
    fi
    zizmor_config="$tmp/zizmor.yml"
fi
name="$(repo_config "${ACTIONLINT_REPO_CONFIGS[@]}")" || exit 1
if [ -n "$name" ]; then
    git cat-file blob "$tip:$name" >"$tmp/actionlint.yaml"
    problems="$(actionlint_violations "$tmp/actionlint.yaml")"
    if [ -n "$problems" ]; then
        echo >&2 "❌ Push rejected: $name at ${tip:0:12} relaxes actionlint without a reason:"
        printf '%s\n' "$problems" | sed 's/^/   /' >&2
        exit 1
    fi
    actionlint_config="$tmp/actionlint.yaml"
fi

workflows=()
actions=0
for path in ${files[@]+"${files[@]}"}; do
    case "$path" in
        "$WORKFLOW_DIR"/*.yml | "$WORKFLOW_DIR"/*.yaml) workflows+=("$path") ;;
        action.yml | action.yaml | */action.yml | */action.yaml) actions=$((actions + 1)) ;;
    esac
done

# Both scanners run even when the first fails, so one push shows every
# finding instead of one tool's at a time.
scan_workflows() {
    local status=0
    cd "$tree" || return 1
    # A push that deletes the last workflow leaves nothing to scan, and
    # zizmor treats an empty input as an error.
    if [ "${#workflows[@]}" -eq 0 ] && [ "$actions" -eq 0 ]; then
        echo "pre-push: $CHECK: no workflows or actions left at ${tip:0:12}"
        return 0
    fi
    if [ "${#workflows[@]}" -gt 0 ]; then
        echo "pre-push: actionlint"
        actionlint -config-file "$actionlint_config" "${workflows[@]}" || status=1
    fi
    echo "pre-push: zizmor"
    zizmor --offline --no-progress --quiet "--persona=$ZIZMOR_PERSONA" --config "$zizmor_config" . || status=1
    return "$status"
}

if ! (scan_workflows); then
    echo >&2 "❌ Push rejected: GitHub workflow scan found problems at ${tip:0:12} (see above)"
    echo >&2 "   Fix the findings; pin every action to a full commit SHA (uses: owner/repo@<sha> # vX.Y.Z)."
    exit 1
fi
