#!/usr/bin/env bash
# Prepare this clone for the local-hooks standard v2 (ASG-745).
#
# The global hooks (dotf ~/.git-hooks) dispatch to .githooks/<hook>.d/*, so
# this repository must NOT set core.hooksPath: a local value hides the
# global sign-off and signature guards. This script removes any local or
# worktree core.hooksPath and the v1 router directory, then tells you to
# review and trust the hooks with githooks-trust (a human step).
# Usage: setup-hooks [--dry-run]
set -euo pipefail

dry_run=0
[ "${1:-}" = --dry-run ] && dry_run=1
run() { if [ "$dry_run" -eq 1 ]; then echo "would run: $*"; else "$@"; fi; }

top="$(git rev-parse --show-toplevel)"
common="$(cd "$(git rev-parse --git-common-dir)" && pwd -P)"

scopes=(local)
# --worktree only differs from --local when per-worktree config is enabled.
[ "$(git config --type=bool --get extensions.worktreeConfig 2>/dev/null || true)" = true ] && scopes+=(worktree)
for scope in "${scopes[@]}"; do
    value="$(git config "--$scope" --get core.hooksPath 2>/dev/null || true)"
    [ -n "$value" ] || continue
    echo "removing $scope core.hooksPath=$value"
    run git config "--$scope" --unset-all core.hooksPath
done
if [ -d "$common/project-hooks" ]; then
    echo "removing v1 router $common/project-hooks"
    run rm -rf -- "$common/project-hooks"
fi

global="$(git config --global --includes --path --get core.hooksPath 2>/dev/null || true)"
if [ -z "$global" ] || [ ! -x "$global/lib/dispatch.sh" ]; then
    echo "warning: the global hooks have no v2 dispatcher (core.hooksPath=${global:-unset});" >&2
    echo "         .githooks/<hook>.d will not run until dotf v2 is installed." >&2
fi
echo "next: review and trust the hooks once per worktree: githooks-trust $top"
