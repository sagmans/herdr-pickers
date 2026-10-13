#!/bin/sh
# Points this repository at its tracked .githooks directory.
#
# Checks run locally instead of in push/PR CI, so every clone needs the hooks
# active. The tracked runner chains the machine-wide global hooks first
# (sign-off, message format, signature checks), which a repo-local
# core.hooksPath would otherwise hide.
#
# Usage: scripts/setup-hooks.sh [--force]
#   --force  replace a different repo-local core.hooksPath value
set -eu

# Relative on purpose: it resolves against each worktree's root, so every
# branch runs the hooks committed on that branch.
HOOKS_DIR='.githooks'
# Hooks Git must reach in this repository; the global set lives under the same names.
REQUIRED_HOOKS='pre-commit prepare-commit-msg commit-msg pre-push'

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
for hook in $REQUIRED_HOOKS; do
	if [ ! -x "$top/$HOOKS_DIR/$hook" ]; then
		echo "error: missing or non-executable $HOOKS_DIR/$hook" >&2
		exit 1
	fi
done

# An existing value may belong to another tool or a hand-made router; never
# replace it silently.
current=$(git config --local --get core.hooksPath 2>/dev/null || true)
if [ -n "$current" ] && [ "$current" != "$HOOKS_DIR" ] && [ "$force" -ne 1 ]; then
	echo "error: core.hooksPath is already set to '$current'; rerun with --force to replace it" >&2
	exit 1
fi
git config --local core.hooksPath "$HOOKS_DIR"
echo "core.hooksPath=$HOOKS_DIR"

global_dir=$(git config --global --includes --type=path --get core.hooksPath 2>/dev/null || true)
echo "global hooks: ${global_dir:-none (only repo hooks will run)}"

# The value is shared by every worktree of a bare repository. A worktree whose
# branch predates .githooks would run no hooks at all, global ones included.
git worktree list --porcelain | sed -n 's/^worktree //p' | while IFS= read -r wt; do
	if [ -d "$wt/.git" ] || [ -f "$wt/.git" ]; then
		[ -d "$wt/$HOOKS_DIR" ] || echo "warning: worktree without $HOOKS_DIR runs no hooks: $wt" >&2
	fi
done
