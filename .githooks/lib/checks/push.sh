#!/usr/bin/env bash
# Generic check: pre-push. Copied from the shared hook template.
# Every new commit must carry one Signed-off-by per person (DCO), a signature
# git can verify, a message with the structure and convention commit-msg asks
# for (lib/convention.sh, the same rules, plus no fixup!/squash!/amend!/WIP
# subjects), and no secrets. Then the scanners judge the pushed range: workflows at the tip
# (workflows.sh), dependencies at each lockfile change or the tip (deps.sh),
# changed source files with static analysis at the tip (sast.sh), and the
# complexity of the functions the push changes (complexity.sh). This
# is the last check before code leaves the machine, and it also catches
# commits that were made with hooks off or reworded later.
# Reads git's pre-push ref lines on stdin; $1 is the remote name.
# shellcheck disable=SC2034  # local_ref/remote_ref/remote_sha/url required by git hook protocol

set -euo pipefail

# shellcheck source-path=SCRIPTDIR source=../convention.sh
. "$(dirname -- "${BASH_SOURCE[0]}")/../convention.sh"
# shellcheck source-path=SCRIPTDIR source=../helpers.sh
. "$(dirname -- "${BASH_SOURCE[0]}")/../helpers.sh"

remote="$1"
checks_dir="$(dirname -- "${BASH_SOURCE[0]}")"
# Release pipelines are tag-triggered, so a tag is what ships: it must be a
# signed annotated tag, the same trust bar as the commits it points to.
tag_prefix="refs/tags/"

while read -r local_ref local_sha remote_ref remote_sha; do
    # A deletion adds no commits. An all-zero ID of any length, so a SHA-256
    # repository is handled too.
    if is_null_oid "$local_sha"; then
        continue
    fi

    case "$local_ref" in
    "$tag_prefix"*)
        tag_name="${local_ref#"$tag_prefix"}"
        # A lightweight tag has no tag object, so it can carry no signature.
        if [ "$(git cat-file -t "$local_sha" 2>/dev/null)" != "tag" ] ||
            ! git verify-tag "$local_sha" >/dev/null 2>&1; then
            echo >&2 "❌ Push rejected: tag $tag_name must be signed: use git tag -s"
            exit 1
        fi
        ;;
    esac

    # Only commits after the remote default-branch tip are judged (shared
    # with pushed_shas in lib/helpers.sh). Fail closed: if git cannot list
    # the commits, reject instead of checking nothing.
    rev_args=()
    range="$(push_range_args "$local_sha" "$remote_sha" "$remote")"
    while IFS= read -r arg; do
        rev_args+=("$arg")
    done <<<"$range"
    if ! shas="$(git rev-list "${rev_args[@]}")"; then
        echo >&2 "❌ Push rejected: cannot list the commits to verify for $local_ref (try git fetch)"
        exit 1
    fi

    while IFS= read -r sha && [ -n "$sha" ]; do
        msg=$(git log -n 1 --format=%B "$sha")
        CONVENTION_FOUND=''
        convention_dco "$msg"
        if [ -n "$CONVENTION_FOUND" ]; then
            echo >&2 "❌ Push rejected: commit ${sha:0:12} breaks the DCO sign-off rules"
            echo >&2 "   $(git log -n 1 --format='%s' "$sha")"
            convention_report "$CONVENTION_FOUND"
            exit 1
        fi
        if ! git verify-commit "$sha" >/dev/null 2>&1; then
            echo >&2 "❌ Push rejected: commit ${sha:0:12} is unsigned or unverifiable"
            echo >&2 "   $(git log -n 1 --format='%s' "$sha")"
            echo >&2 "   sign with git commit -S; verifying needs gpg.ssh.allowedSignersFile (or gpg) set up"
            exit 1
        fi
        # git writes merge messages itself, so only authored commits are judged.
        [ -z "$(git rev-list --no-walk --min-parents=2 "$sha")" ] || continue
        convention_structure "$msg"
        if ! violations="$(convention_violations "$msg" push)"; then
            CONVENTION_FOUND+="$violations"$'\n'
        fi
        if [ -n "$CONVENTION_FOUND" ]; then
            echo >&2 "❌ Push rejected: commit ${sha:0:12} breaks the commit convention"
            echo >&2 "   $(git log -n 1 --format='%s' "$sha")"
            convention_report "$CONVENTION_FOUND"
            echo >&2 "   Reword it with git rebase -i <base>, then push again."
            exit 1
        fi
    done <<< "$shas"

    [ -n "$shas" ] || continue
    # Scanners judge the tree the remote will hold, so they run at the tip,
    # and repo relaxations are read from it; a tag push names the tag
    # object, which is peeled to its commit.
    tip="$(git rev-parse --verify "${local_sha}^{commit}")"
    if ! "$checks_dir/secrets.sh" range "$tip" "${rev_args[@]}" </dev/null; then
        echo >&2 "❌ Push rejected: secret scan found leaks in $local_ref (see above)"
        exit 1
    fi

    # stdin still holds the ref lines this loop reads; scanners must not eat them.
    "$checks_dir/workflows.sh" "$tip" "${rev_args[@]}" </dev/null || exit 1
    "$checks_dir/deps.sh" "$tip" "${rev_args[@]}" </dev/null || exit 1
    "$checks_dir/sast.sh" "$tip" "${rev_args[@]}" </dev/null || exit 1
    "$checks_dir/complexity.sh" "$tip" "${rev_args[@]}" </dev/null || exit 1
done

exit 0
