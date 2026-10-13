#!/bin/sh
# Shared tool resolver for project hooks, sourced (not executed).
#
# The repo pins bun in mise.toml and mise.lock; running through mise keeps
# local checks on the same toolchain the release workflow uses. Without mise
# the PATH tool is used, so hooks still work on a plain machine.
run_tool() {
	if command -v mise >/dev/null 2>&1; then
		mise exec -- "$@"
	else
		"$@"
	fi
}
