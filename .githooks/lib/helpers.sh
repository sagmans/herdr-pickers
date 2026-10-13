#!/bin/sh
# shellcheck disable=SC3043  # `local` is supported by every sh we target
# Helpers for a repo's own checks in .githooks/<hook>.d/. Copied from the dotf
# template (templates/githooks) so the repo needs nothing outside itself.
# The hook runner (lib/run-local.sh) exports HOOK_HELPERS with this path and,
# where relevant, PROJECT_HOOK_INDEX_FILE (pre-commit) and HOOK_STDIN_FILE
# (pre-push). Source it from a .d script:
#   . "${HOOK_HELPERS:?run from .githooks (scripts/setup-hooks)}"
# POSIX sh plus `local`, so it works with bash 3.2, dash, zsh and macOS sh.

# Run git against the index being committed. `commit -a`, `commit <paths>`
# and `--only` use a temporary index, so this follows the one git chose.
#   staged_git diff --cached --check
staged_git() {
	: "${PROJECT_HOOK_INDEX_FILE:?staged_git: pre-commit only}"
	GIT_INDEX_FILE=$PROJECT_HOOK_INDEX_FILE git "$@"
}

# pre-push: print the local SHAs being pushed (deletions skipped), one per
# line, from git's ref lines. Use a for loop, never `pushed_shas | while`:
# a failure inside a piped loop only ends the subshell, so the push passes.
#   shas=$(pushed_shas <"$HOOK_STDIN_FILE") || exit 1
#   for sha in $shas; do at_sha "$sha" make test || exit 1; done
pushed_shas() {
	local z40 _lr local_sha _rr _rs
	z40=0000000000000000000000000000000000000000
	while read -r _lr local_sha _rr _rs; do
		[ -n "$local_sha" ] || continue
		case "$local_sha" in
		*[!0-9a-f]*) echo "pushed_shas: malformed ref line" >&2; return 1 ;;
		esac
		[ "$local_sha" = "$z40" ] && continue
		printf '%s\n' "$local_sha"
	done
	return 0
}

# pre-push: run a command against exactly the pushed commit, so a push of
# several commits or of a branch that is not checked out tests what leaves
# the machine. In place when the commit is a clean HEAD; otherwise in a
# temporary detached worktree that is removed afterwards.
at_sha() {
	local sha tmp rc
	sha=$1
	shift
	git rev-parse --verify -q "$sha^{commit}" >/dev/null || { echo "at_sha: unknown commit $sha" >&2; return 1; }
	if [ "$(git rev-parse HEAD)" = "$(git rev-parse "$sha^{commit}")" ] &&
		git diff --quiet HEAD -- && [ -z "$(git ls-files --others --exclude-standard)" ]; then
		"$@"
		return
	fi
	tmp=$(mktemp -d "${TMPDIR:-/tmp}/hook-at-sha.XXXXXX") || return 1
	git worktree add -q --detach "$tmp/wt" "$sha" || { rmdir "$tmp"; return 1; }
	rc=0
	# git's per-repo variables would point the command back at this worktree.
	(cd "$tmp/wt" && unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE && "$@") || rc=$?
	git worktree remove --force "$tmp/wt" >/dev/null 2>&1 || true
	# Only the mktemp directory this call created, never a computed parent.
	case "$tmp" in
	*/hook-at-sha.*) rm -rf -- "$tmp" ;;
	esac
	return "$rc"
}

# Steps that need the macOS SDK print a skip notice elsewhere instead of
# blocking commits on Linux machines.
darwin_only() {
	if [ "$(uname -s)" != Darwin ]; then
		echo "skip (macOS only): $*" >&2
		return 0
	fi
	"$@"
}
