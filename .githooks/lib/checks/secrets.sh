#!/usr/bin/env bash
# Generic check: secret scan with gitleaks. Copied from the shared hook
# template.
# A leaked key cannot be taken back once pushed, so
# the scan runs on the staged change (pre-commit) and again on every pushed
# commit (pre-push), which also covers commits made without hooks.
# Usage: secrets.sh staged | secrets.sh range <tip-sha> <git rev-list args...>
# A missing scanner fails the hook: an unscanned push is not a passed one.
# The rules are the hook's own (lib/gitleaks.toml), passed explicitly: gitleaks
# would otherwise load a .gitleaks.toml or .gitleaksignore from the working
# tree, where an untracked file could turn the scan off. The only accepted
# relaxation is a tracked .gitleaksignore, read from what is committed (the
# index or the pushed tip), with a reason above each fingerprint. Inline
# gitleaks:allow comments still work and need review.

set -euo pipefail

SCANNER=gitleaks
INSTALL_HINT='install gitleaks (https://github.com/gitleaks/gitleaks), e.g. brew install gitleaks or mise use gitleaks'
lib_dir="$(cd "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
BASE_CONFIG="$lib_dir/gitleaks.toml"
IGNORE_FILE=.gitleaksignore
REPO_CONFIG=.gitleaks.toml

if ! command -v "$SCANNER" >/dev/null 2>&1; then
	echo >&2 "❌ secret scan: $SCANNER not found; $INSTALL_HINT"
	exit 1
fi

mode="${1:-}"
shift || true
case "$mode" in
staged)
	# Read from the index git is committing (a temporary one for commit -a).
	spec_prefix=':'
	if [ -n "${PROJECT_HOOK_INDEX_FILE:-}" ]; then
		export GIT_INDEX_FILE="$PROJECT_HOOK_INDEX_FILE"
	fi
	;;
range)
	tip="${1:?usage: secrets.sh range <tip-sha> <rev-list args...>}"
	shift
	spec_prefix="$tip:"
	;;
*)
	echo >&2 "secrets.sh: usage: secrets.sh staged | secrets.sh range <tip-sha> <rev-list args>"
	exit 2
	;;
esac

tmp="$(mktemp -d "${TMPDIR:-/tmp}/hook-secrets.XXXXXX")"
# Only the mktemp directory this run created, never a computed parent.
cleanup() {
	case "$tmp" in
	*/hook-secrets.*) rm -rf -- "$tmp" ;;
	esac
}
trap cleanup EXIT
ignore_copy="$tmp/$IGNORE_FILE"
: >"$ignore_copy"

if git cat-file -e "$spec_prefix$REPO_CONFIG" 2>/dev/null; then
	echo >&2 "⚠ secret scan: $REPO_CONFIG is not used; the hook runs its own rules. Accept a finding in $IGNORE_FILE instead."
fi

# Every fingerprint needs a reason comment on the line above it, so each
# accepted finding says why it is safe.
if git cat-file -e "$spec_prefix$IGNORE_FILE" 2>/dev/null; then
	git cat-file blob "$spec_prefix$IGNORE_FILE" >"$ignore_copy"
	missing="$(awk '
		/^[[:space:]]*$/ { reason = 0; next }
		/^[[:space:]]*#/ { reason = ($0 ~ /^[[:space:]]*#[[:space:]]*[^[:space:]]/); next }
		!reason { printf "%d ", NR }
		{ reason = 0 }
	' "$ignore_copy")"
	if [ -n "$missing" ]; then
		echo >&2 "❌ secret scan: $IGNORE_FILE accepts findings without a reason (lines: ${missing% })"
		echo >&2 "   Fix: put a '# why this is not a secret' comment on the line above each fingerprint."
		exit 1
	fi
fi

# gitleaks also loads .gitleaksignore from the directory it scans, on top of
# --gitleaks-ignore-path. It is pointed at an empty directory instead, and
# GIT_DIR/GIT_WORK_TREE take git to the repository.
GIT_DIR="$(git rev-parse --absolute-git-dir)"
GIT_WORK_TREE="$(git rev-parse --show-toplevel)"
export GIT_DIR GIT_WORK_TREE
source_dir="$tmp/source"
mkdir "$source_dir"
scan_args=(--config "$BASE_CONFIG" --gitleaks-ignore-path "$ignore_copy" --redact --no-banner --log-level warn)
case "$mode" in
staged)
	# git exports GIT_INDEX_FILE for the commit, so the scan sees exactly
	# what is being committed, including `commit -a` and `commit <paths>`.
	scan=("$SCANNER" git --pre-commit --staged "${scan_args[@]}" "$source_dir")
	;;
range)
	# git log shows no diff for a merge by default, so a secret added while
	# resolving one would pass; compare each merge with its first parent.
	scan=("$SCANNER" git --log-opts="--diff-merges=first-parent $*" "${scan_args[@]}" "$source_dir")
	;;
esac
# gitleaks logs a failed git command and still exits 0, so its error lines
# decide too: a scan that did not run is not a pass.
rc=0
"${scan[@]}" 2>"$tmp/stderr" || rc=$?
cat "$tmp/stderr" >&2
if [ "$rc" -eq 0 ] && grep -q 'ERR' "$tmp/stderr"; then
	echo >&2 "❌ secret scan: $SCANNER reported an error (see above); a scan that did not run is not a pass"
	exit 1
fi
[ "$rc" -eq 0 ] || exit "$rc"
