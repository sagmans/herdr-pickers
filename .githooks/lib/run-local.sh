#!/usr/bin/env bash
# Sourced by every hook in .githooks. Runs the repo's own checks in
# .githooks/<hook>.d/ after the generic checks, in name order, and stops at
# the first failure so a broken check can never let a commit or push pass.
# Copied from the dotf template (templates/githooks).

HOOKS_DIR="$(cd "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
export HOOK_HELPERS="$HOOKS_DIR/lib/helpers.sh"
# shellcheck disable=SC2034  # used by the hooks that source this file
CHECKS_DIR="$HOOKS_DIR/lib/checks"

# run_local <hook> [args...]
run_local() {
	local hook="$1" dir check
	shift
	dir="$HOOKS_DIR/$hook.d"
	[ -d "$dir" ] || return 0
	for check in "$dir"/*; do
		[ -f "$check" ] || continue
		# A check without the exec bit would be skipped silently by a plain
		# loop; failing makes the missing bit visible.
		if [ ! -x "$check" ]; then
			echo >&2 "❌ $hook: $check is not executable (chmod +x it)"
			return 1
		fi
		# git exports per-repo variables (GIT_DIR, GIT_INDEX_FILE, ...) to
		# hooks. A check that runs git in another repo, such as a test that
		# makes a scratch repo, would otherwise write to this one. Checks
		# find the repo from the working directory (the worktree top) and
		# read the commit's index through PROJECT_HOOK_INDEX_FILE.
		if ! (
			unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_PREFIX GIT_COMMON_DIR \
				GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES
			exec "$check" "$@" <"${HOOK_STDIN_FILE:-/dev/null}"
		); then
			echo >&2 "❌ $hook: check $(basename -- "$check") failed"
			return 1
		fi
	done
}
