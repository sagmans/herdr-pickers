#!/bin/sh
# Enables this repository's tracked git hooks.
#
# Checks run locally instead of in push/PR CI, so every clone needs the hooks
# active. Git honors a single core.hooksPath, and a repo-local value hides the
# machine-wide global hooks (sign-off, message format, signature checks).
#
# Preferred path: the per-machine project-git-hooks installer builds an
# untracked router in the Git common directory and points core.hooksPath at
# it with an absolute path. The router runs the global hook, then this
# worktree's .githooks/<hook> when it exists, so branches and worktrees that
# predate .githooks still run the global hooks.
#
# Fallback for machines without that installer: a relative .githooks path.
# It runs the global hooks too (through .githooks/_lib/run-hook.sh), but only
# in checkouts that contain .githooks.
#
# Usage: scripts/setup-hooks.sh [--force]
#   --force  replace a different repo-local core.hooksPath value (fallback only)
set -eu

INSTALLER="${PROJECT_HOOKS_SCRIPT:-$HOME/.agents/skills/project-git-hooks/scripts/project-hooks.sh}"
FALLBACK_HOOKS_DIR='.githooks'

force=0
case "${1:-}" in
--force) force=1 ;;
'') ;;
*)
	echo "usage: scripts/setup-hooks.sh [--force]" >&2
	exit 2
	;;
esac

top=$(git rev-parse --show-toplevel)

if [ -f "$INSTALLER" ]; then
	bash "$INSTALLER" install --repo "$top"
	bash "$INSTALLER" check --repo "$top"
	exit 0
fi

echo "warning: $INSTALLER not found; using relative core.hooksPath=$FALLBACK_HOOKS_DIR" >&2
echo "warning: checkouts without $FALLBACK_HOOKS_DIR will run no hooks, global ones included" >&2
# An existing value may belong to another tool or the router; never replace it silently.
current=$(git config --local --get core.hooksPath 2>/dev/null || true)
if [ -n "$current" ] && [ "$current" != "$FALLBACK_HOOKS_DIR" ] && [ "$force" -ne 1 ]; then
	echo "error: core.hooksPath is already set to '$current'; rerun with --force to replace it" >&2
	exit 1
fi
git config --local core.hooksPath "$FALLBACK_HOOKS_DIR"
echo "core.hooksPath=$FALLBACK_HOOKS_DIR"
