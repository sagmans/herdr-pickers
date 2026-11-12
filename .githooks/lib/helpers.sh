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

# Status of a step the watchdog stopped, as GNU timeout returns it, so a caller
# can tell a hang from a failed check.
TIMEOUT_EXIT_STATUS=124
# Status for a limit that is not a positive whole number. A limit that cannot
# be read must block the step, because an unbounded step is the fault that the
# watchdog exists to stop.
TIMEOUT_USAGE_STATUS=125
# Time for a stopped step to clean up (temporary files, containers) after TERM.
# A step that is still alive after this gets KILL, so a step that ignores TERM
# cannot hold the push.
TIMEOUT_KILL_GRACE_SECONDS=5
# A signal ends the shell with 128 + its number; the same status for a step
# that the user or the session stopped.
SIGNAL_STATUS_HUP=129
SIGNAL_STATUS_INT=130
SIGNAL_STATUS_TERM=143
# Limit for one read of the remote's default branch. It is a small request, and
# a hang here means that the push cannot reach the remote at all.
PUSH_BASE_READ_TIMEOUT_SECONDS=30

# Print a process and all its descendants, one PID per line. One `ps` snapshot,
# so the list is taken before any signal: a child of a stopped parent moves to
# init and could not be found afterwards. POSIX `ps`, because `pgrep` is not on
# every machine.
process_tree() {
	ps -A -o pid= -o ppid= | awk -v root="$1" '
		{ parent[$1] = $2 }
		END {
			tree[root] = 1
			print root
			do {
				grew = 0
				for (pid in parent) {
					if (!(pid in tree) && (parent[pid] in tree)) {
						tree[pid] = 1
						print pid
						grew = 1
					}
				}
			} while (grew)
		}'
}

# True while a PID in the list is alive. One at a time, because `kill -0` with
# several PIDs returns a different status in bash and in dash.
any_alive() {
	local alive_pid
	for alive_pid in $1; do
		kill -0 "$alive_pid" 2>/dev/null && return 0
	done
	return 1
}

# The body of the watchdog process: at the limit, write the flag, send TERM to
# the step's process tree, then KILL what is alive after the grace time. The
# signals reach the whole tree because a package manager or test runner dies
# first and leaves the real worker hung behind it. The flag comes first, so the
# step counts as stopped however it exits.
#   watch_step <pid> <seconds> <flag-file>
watch_step() {
	local waited tree
	waited=0
	while [ "$waited" -lt "$2" ]; do
		sleep 1
		kill -0 "$1" 2>/dev/null || exit 0
		waited=$((waited + 1))
	done
	tree=$(process_tree "$1")
	echo timeout >"$3"
	# shellcheck disable=SC2086  # one PID per word
	kill -TERM $tree 2>/dev/null || true
	waited=0
	while [ "$waited" -lt "$TIMEOUT_KILL_GRACE_SECONDS" ] && any_alive "$tree"; do
		sleep 1
		waited=$((waited + 1))
	done
	# shellcheck disable=SC2086  # one PID per word
	kill -KILL $tree 2>/dev/null || true
}

# Trap action of run_with_timeout: the user or the session stopped the hook. The
# step does not get a terminal signal itself: an asynchronous command starts
# with SIGINT ignored. The status comes back to at_sha, which then removes its
# worktree. Globals, because a trap runs outside the scope of `local`.
stop_step() {
	local stop_tree
	stop_tree=$(process_tree "$STEP_PID")
	kill "$STEP_WATCHER" 2>/dev/null || true
	# shellcheck disable=SC2086  # one PID per word
	kill -TERM $stop_tree 2>/dev/null || true
	rm -f -- "$STEP_FLAG"
	exit "$1"
}

# run_with_timeout <seconds> <cmd...>
# Run a command and stop it when it hangs, so a dead connection or daemon blocks
# the push instead of freezing it. Plain shell, because GNU timeout is not on
# stock macOS. Returns the command's status, 124 on timeout, or 125 for a bad
# limit. A stopped command returns 124 whatever its own status is: one that
# exits 0 on TERM has still not finished its check.
# The command runs asynchronously, so its stdin is /dev/null. A redirect on this
# call does not reach it: to feed it a file, wrap the command and the redirect
# in a function. The INT, TERM and HUP traps of the caller end here.
run_with_timeout() {
	local seconds rc
	seconds=$1
	shift
	case "$seconds" in
	'' | *[!0-9]* | 0 | 00*)
		echo "run_with_timeout: the limit must be a positive whole number, got '$seconds'" >&2
		return "$TIMEOUT_USAGE_STATUS"
		;;
	esac
	STEP_FLAG=$(mktemp "${TMPDIR:-/tmp}/hook-timeout.XXXXXX") || return 1
	"$@" &
	STEP_PID=$!
	# The watchdog must not hold the caller's stdout or stderr open, or a
	# caller that captures output would wait for it.
	watch_step "$STEP_PID" "$seconds" "$STEP_FLAG" </dev/null >/dev/null 2>&1 &
	STEP_WATCHER=$!
	trap 'stop_step "$SIGNAL_STATUS_HUP"' HUP
	trap 'stop_step "$SIGNAL_STATUS_INT"' INT
	trap 'stop_step "$SIGNAL_STATUS_TERM"' TERM
	rc=0
	wait "$STEP_PID" || rc=$?
	if [ -s "$STEP_FLAG" ]; then
		# The step can be gone while its workers still run: let the watchdog
		# finish them, so nothing that the hook started outlives the hook.
		wait "$STEP_WATCHER" 2>/dev/null || true
		rc=$TIMEOUT_EXIT_STATUS
	else
		kill "$STEP_WATCHER" 2>/dev/null || true
		wait "$STEP_WATCHER" 2>/dev/null || true
	fi
	trap - HUP INT TERM
	# Only the mktemp file this call created.
	case "$STEP_FLAG" in
	*/hook-timeout.*) rm -f -- "$STEP_FLAG" ;;
	esac
	return "$rc"
}

# Run one pre-push step under a limit, and name it when it hangs: the reader
# must see which step blocked the push and for how long, not only that the hook
# failed. Put each limit in a named constant at the top of the check.
#   run_step 'pnpm audit' "$NETWORK_TIMEOUT_SECONDS" pnpm audit --audit-level high || return 1
run_step() {
	local name limit started rc
	name=$1
	limit=$2
	shift 2
	started=$(date +%s)
	rc=0
	run_with_timeout "$limit" "$@" || rc=$?
	if [ "$rc" -eq "$TIMEOUT_EXIT_STATUS" ]; then
		echo "❌ Push rejected: step '$name' timed out after $(($(date +%s) - started))s (limit ${limit}s)" >&2
	fi
	return "$rc"
}

# `git ls-remote` for run_step: its errors stay quiet, because a remote that
# answers with an error only sends push_default_base to its fallback, while
# run_step still prints a timeout.
ls_remote_quiet() {
	git ls-remote "$@" 2>/dev/null
}

# pre-push: print the tip SHA of the remote's default branch, or nothing.
# Commits up to that tip are already shared, so a push is judged only on
# what it adds after it. Asks the remote first (its HEAD may differ from the
# local view), then falls back to remote-tracking refs. Never a local
# branch: on a first push it is the pushed tip itself, and the range after it
# is empty, so nothing would be checked. pre-push computes it once and
# exports HOOK_PUSH_BASE_SHA, so checks do not each ask the network again.
# A remote that answers with an error goes to the fallback. A remote that hangs
# fails with 124: nothing can be pushed to it, so the hook stops at once.
# The step names leave out the remote and the branch. A pushed URL can hold
# credentials, and the remote chooses its branch name; a timeout prints the name.
push_default_base() {
	local remote branch sha candidate answer rc
	remote=$1
	rc=0
	answer=$(run_step "read the default branch of the remote" "$PUSH_BASE_READ_TIMEOUT_SECONDS" \
		ls_remote_quiet --symref "$remote" HEAD) || rc=$?
	[ "$rc" -ne "$TIMEOUT_EXIT_STATUS" ] || return "$rc"
	# A here-document, not a pipe into `head -n 1`: head exits early, the
	# writer takes SIGPIPE, and pipefail would abort the hook on an answer with
	# many symref lines. So sed takes the first match itself: the address
	# selects a symref line, `s##` reuses that regex for its \1, and `q` stops.
	branch=$(sed -n '\#^ref: refs/heads/\([^[:space:]]*\)[[:space:]]*HEAD$#{s##\1#p;q;}' <<EOF
$answer
EOF
	)
	if [ -n "$branch" ]; then
		rc=0
		answer=$(run_step "read the tip of the default branch on the remote" "$PUSH_BASE_READ_TIMEOUT_SECONDS" \
			ls_remote_quiet "$remote" "refs/heads/$branch") || rc=$?
		[ "$rc" -ne "$TIMEOUT_EXIT_STATUS" ] || return "$rc"
		sha=$(printf '%s\n' "$answer" | awk 'NR == 1 { print $1 }')
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
		HOOK_PUSH_BASE_SHA=$(push_default_base "$remote") || return 1
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
		args=$(push_range_args "$local_sha" "$remote_sha" "$remote") || return 1
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
