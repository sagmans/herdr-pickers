#!/bin/sh
# shellcheck disable=SC3043  # `local` is supported by every sh we target
# Helpers for a repo's own checks in .githooks/<hook>.d/. Copied from the shared
# hook template so the repo needs nothing outside itself.
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

# True when the object ID is all zeros: git's "no object" in pre-push ref
# lines (a deletion, or a ref the remote does not have yet). Any length, so a
# SHA-256 repository (64 hex characters) is handled like a SHA-1 one (40).
#   is_null_oid "$local_sha" && continue
is_null_oid() {
	case "$1" in
	'' | *[!0]*) return 1 ;;
	esac
	return 0
}

# Object ID lengths in hex: SHA-1 and SHA-256 repositories.
OID_HEX_LENGTHS=' 40 64 '

# pre-push: print the tip SHA of the remote's default branch, or nothing.
# Commits up to that tip are already shared, so a push is judged only on
# what it adds after it. Asks the remote first (its HEAD may differ from the
# local view), then falls back to remote-tracking refs. Never a local
# branch: on a first push it is the pushed tip itself, and the range after it
# is empty, so nothing would be checked. pre-push computes it once and
# exports HOOK_PUSH_BASE_SHA, so checks do not each ask the network again.
push_default_base() {
	local remote branch sha candidate
	remote=$1
	branch=$(git ls-remote --symref "$remote" HEAD 2>/dev/null |
		sed -n 's#^ref: refs/heads/\([^[:space:]]*\)[[:space:]]*HEAD$#\1#p' | head -n 1)
	if [ -n "$branch" ]; then
		sha=$(git ls-remote "$remote" "refs/heads/$branch" 2>/dev/null | awk 'NR == 1 { print $1 }')
		if [ -n "$sha" ]; then
			printf '%s\n' "$sha"
			return 0
		fi
		if sha=$(git rev-parse --verify --quiet "refs/remotes/$remote/$branch^{commit}" 2>/dev/null); then
			printf '%s\n' "$sha"
			return 0
		fi
	fi
	for candidate in "refs/remotes/$remote/main" refs/remotes/origin/main \
		"refs/remotes/$remote/HEAD" refs/remotes/origin/HEAD; do
		if sha=$(git rev-parse --verify --quiet "$candidate^{commit}" 2>/dev/null); then
			printf '%s\n' "$sha"
			return 0
		fi
	done
	return 0
}

# pre-push: print the `git rev-list` arguments, one per line, that select
# the commits one ref line adds: after the default-branch base when it is
# known locally, else after the remote's old tip, else everything no
# remote-tracking ref of this remote holds. lib/checks/push.sh and
# pushed_shas share it, so the generic and the repo checks judge the same set.
#   push_range_args <local-sha> <remote-sha> <remote>
push_range_args() {
	local local_sha remote_sha remote base
	local_sha=$1
	remote_sha=$2
	remote=$3
	if [ -z "${HOOK_PUSH_BASE_SHA+set}" ]; then
		HOOK_PUSH_BASE_SHA=$(push_default_base "$remote")
		export HOOK_PUSH_BASE_SHA
	fi
	base=$HOOK_PUSH_BASE_SHA
	if [ -n "$base" ] && git cat-file -e "$base^{commit}" 2>/dev/null; then
		printf '%s\n' "$base..$local_sha"
	elif ! is_null_oid "$remote_sha" &&
		git cat-file -e "$remote_sha^{commit}" 2>/dev/null; then
		printf '%s\n' "$remote_sha..$local_sha"
	else
		printf '%s\n' "$local_sha" --not "--remotes=$remote"
	fi
}

# pre-push: print every new commit the push adds (deletions skipped), one
# SHA per line, oldest first, each once, from git's ref lines on stdin. The
# remote is $1 or HOOK_PUSH_REMOTE (exported by pre-push). Fails closed when
# a range cannot be listed. Use a for loop, never `pushed_shas | while`: a
# failure inside a piped loop only ends the subshell, so the push passes.
#   shas=$(pushed_shas <"$HOOK_STDIN_FILE") || exit 1
#   for sha in $shas; do at_sha "$sha" make test || exit 1; done
pushed_shas() {
	local remote _lr local_sha _rr remote_sha args arg shas all nl
	remote=${1:-${HOOK_PUSH_REMOTE:-}}
	if [ -z "$remote" ]; then
		echo "pushed_shas: no remote (pass it as \$1 or run from pre-push)" >&2
		return 1
	fi
	nl='
'
	all=''
	while read -r _lr local_sha _rr remote_sha; do
		[ -n "$local_sha" ] || continue
		case "$local_sha$remote_sha" in
		*[!0-9a-f]*) echo "pushed_shas: malformed ref line" >&2; return 1 ;;
		esac
		case "$OID_HEX_LENGTHS" in
		*" ${#local_sha} "*) ;;
		*) echo "pushed_shas: malformed ref line" >&2; return 1 ;;
		esac
		[ "${#remote_sha}" = "${#local_sha}" ] || { echo "pushed_shas: malformed ref line" >&2; return 1; }
		is_null_oid "$local_sha" && continue
		args=$(push_range_args "$local_sha" "$remote_sha" "$remote")
		# One argument per line. The positional parameters keep each line
		# whole without globbing (POSIX sh has no arrays), and IFS changes
		# only for the read, never for the caller. $1 is already in $remote.
		set --
		while IFS= read -r arg; do
			set -- "$@" "$arg"
		done <<-ARGS
			$args
		ARGS
		if ! shas=$(git rev-list --reverse "$@"); then
			echo "pushed_shas: cannot list the commits of $local_sha (try git fetch)" >&2
			return 1
		fi
		[ -z "$shas" ] || all="$all$shas$nl"
	done
	printf '%s' "$all" | awk 'NF && !seen[$0]++'
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
