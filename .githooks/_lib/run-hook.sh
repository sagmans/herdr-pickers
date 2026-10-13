#!/bin/sh
# Shared runner for project Git hooks.
#
# A repository-local core.hooksPath replaces the global one, so Git would stop
# running the machine-wide hooks in this repository. Every hook wrapper in the
# parent directory calls this runner to restore them: the global hook of the
# same name runs first, then the project-specific hooks in <hook>.d/. The global
# hook is resolved at run time, never copied, so updates to the global hooks
# reach this repository without drift. Contributors without global hooks run
# only the project hooks.
#
# Usage: run-hook.sh <hook-name> [git hook arguments...]
# POSIX sh on purpose: the repository may use any stack, and Git ships a POSIX
# shell on every platform it supports.
set -eu

# Project hooks live in <hooks-dir>/<hook>.d/; this runner lives one level down.
PROJECT_HOOK_SUFFIX='.d'
# Git reads hook input (for example pre-push ref lines) only once from stdin;
# both the global and every project hook must see the same bytes.
STDIN_TEMPLATE='git-hook-stdin.XXXXXX'

if [ "$#" -lt 1 ]; then
	echo "usage: run-hook.sh <hook-name> [args...]" >&2
	exit 2
fi
hook_name=$1
shift

hooks_dir=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd -P)

# Global wins over system, the same precedence Git applies. --includes is
# required because the scope flags disable include.path processing by default,
# and global hook settings often live in an included file.
global_dir=$(git config --global --includes --type=path --get core.hooksPath 2>/dev/null ||
	git config --system --includes --type=path --get core.hooksPath 2>/dev/null ||
	true)

# A relative global path has no stable base outside one repository, and a path
# that resolves to this directory would run the project hooks twice.
case "$global_dir" in
/* | [A-Za-z]:[/\\]*)
	if [ -d "$global_dir" ] &&
		[ "$(CDPATH='' cd -- "$global_dir" && pwd -P)" = "$hooks_dir" ]; then
		global_dir=''
	fi
	;;
*) global_dir='' ;;
esac

# Hooks without input get /dev/null from Git; a terminal means a manual run,
# where waiting for input would hang.
stdin_file=''
if [ ! -t 0 ]; then
	stdin_file=$(mktemp "${TMPDIR:-/tmp}/$STDIN_TEMPLATE")
	trap 'rm -f "$stdin_file"' EXIT HUP INT TERM
	cat >"$stdin_file"
fi

# Runs one hook with the buffered input and stops the chain on failure, so a
# rejected commit or push is never overridden by a later hook.
run_one() {
	hook_path=$1
	shift
	if [ -n "$stdin_file" ]; then
		"$hook_path" "$@" <"$stdin_file" || exit "$?"
	else
		"$hook_path" "$@" </dev/null || exit "$?"
	fi
}

if [ -n "$global_dir" ] && [ -f "$global_dir/$hook_name" ] && [ -x "$global_dir/$hook_name" ]; then
	run_one "$global_dir/$hook_name" "$@"
fi

project_dir="$hooks_dir/$hook_name$PROJECT_HOOK_SUFFIX"
if [ -d "$project_dir" ]; then
	# Lexical order gives a numeric prefix (10-, 20-) control over sequencing.
	for project_hook in "$project_dir"/*; do
		[ -f "$project_hook" ] || continue
		# A lost executable bit would otherwise disable a check without notice.
		if [ ! -x "$project_hook" ]; then
			echo "warning: skipped non-executable hook: $project_hook" >&2
			continue
		fi
		run_one "$project_hook" "$@"
	done
fi
