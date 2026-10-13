#!/usr/bin/env bash
# Generic check: pre-push. Copied from the dotf template (templates/githooks).
# Every new commit must carry Signed-off-by (DCO), a signature git can verify,
# and no secrets. This is the last check before code leaves the machine, and
# it also catches commits that were made with hooks off.
# Reads git's pre-push ref lines on stdin; $1 is the remote name.
# shellcheck disable=SC2034  # local_ref/remote_ref/remote_sha/url required by git hook protocol

set -euo pipefail

remote="$1"
z40="0000000000000000000000000000000000000000"

commit_sha_for_ref() {
    git rev-parse --verify --quiet "${1}^{commit}" 2>/dev/null
}

default_branch_sha() {
    local remote_name="$1" branch="" sha=""

    branch=$(git ls-remote --symref "$remote_name" HEAD 2>/dev/null \
        | sed -n 's#^ref: refs/heads/\([^[:space:]]*\)[[:space:]]*HEAD$#\1#p' \
        | head -n 1 || true)

    if [ -n "$branch" ]; then
        sha=$(git ls-remote "$remote_name" "refs/heads/$branch" 2>/dev/null \
            | awk 'NR == 1 { print $1 }' || true)
        if [ -n "$sha" ]; then
            printf '%s\n' "$sha"
            return 0
        fi

        for candidate in \
            "refs/remotes/${remote_name}/${branch}" \
            "refs/heads/${branch}"
        do
            if sha=$(commit_sha_for_ref "$candidate"); then
                printf '%s\n' "$sha"
                return 0
            fi
        done
    fi

    for candidate in \
        "refs/remotes/${remote_name}/main" \
        "refs/remotes/origin/main" \
        "refs/heads/main" \
        "refs/remotes/${remote_name}/HEAD" \
        "refs/remotes/origin/HEAD"
    do
        if sha=$(commit_sha_for_ref "$candidate"); then
            printf '%s\n' "$sha"
            return 0
        fi
    done

    return 0
}

base_sha=""
base_sha_resolved=0

while read -r local_ref local_sha remote_ref remote_sha; do
    # Skip branch deletions
    if [ "$local_sha" = "$z40" ]; then
        continue
    fi

    # Sign-off validation only applies to commits made after the remote default branch tip.
    if [ "$base_sha_resolved" -eq 0 ]; then
        base_sha="$(default_branch_sha "$remote")"
        base_sha_resolved=1
    fi

    # R5: fail closed. Use a known local base when there is one; otherwise
    # check everything not already on any remote-tracking ref of this remote.
    # If git cannot list the commits, reject instead of checking nothing.
    if [ -n "$base_sha" ] && git cat-file -e "${base_sha}^{commit}" 2>/dev/null; then
        rev_args=("${base_sha}..${local_sha}")
    elif [ "$remote_sha" != "$z40" ] && git cat-file -e "${remote_sha}^{commit}" 2>/dev/null; then
        rev_args=("${remote_sha}..${local_sha}")
    else
        rev_args=("$local_sha" --not "--remotes=$remote")
    fi
    if ! shas="$(git rev-list "${rev_args[@]}")"; then
        echo >&2 "❌ Push rejected: cannot list the commits to verify for $local_ref (try git fetch)"
        exit 1
    fi

    while IFS= read -r sha && [ -n "$sha" ]; do
        msg=$(git log -n 1 --format=%B "$sha")
        if ! echo "$msg" | grep -q '^Signed-off-by: '; then
            echo >&2 "❌ Push rejected: commit ${sha:0:12} is missing Signed-off-by"
            echo >&2 "   $(git log -n 1 --format='%s' "$sha")"
            exit 1
        fi
        if ! git verify-commit "$sha" >/dev/null 2>&1; then
            echo >&2 "❌ Push rejected: commit ${sha:0:12} is unsigned or unverifiable"
            echo >&2 "   $(git log -n 1 --format='%s' "$sha")"
            echo >&2 "   sign with git commit -S; verifying needs gpg.ssh.allowedSignersFile (or gpg) set up"
            exit 1
        fi
    done <<< "$shas"

    [ -n "$shas" ] || continue
    if ! "$(dirname -- "${BASH_SOURCE[0]}")/secrets.sh" range "${rev_args[*]}"; then
        echo >&2 "❌ Push rejected: secret scan found leaks in $local_ref (see above)"
        exit 1
    fi
done

exit 0
