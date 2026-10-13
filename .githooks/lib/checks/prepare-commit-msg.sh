#!/usr/bin/env bash
# Generic check: prepare-commit-msg. Copied from the dotf template (templates/githooks).
# Auto-injects Signed-off-by trailer into every commit message.
# This ensures -s behavior without requiring the flag.

set -euo pipefail

COMMIT_MSG_FILE="$1"
COMMIT_SOURCE="${2:-}"

# Skip squash, and a real merge. Cherry-pick --continue also reports source
# merge, because MERGE_MSG exists, but it is not a merge commit. pre-push
# rejects a replay that lacks the trailer, so the injection still has to run.
case "$COMMIT_SOURCE" in
    squash) exit 0 ;;
    merge)
        if ! git rev-parse -q --verify CHERRY_PICK_HEAD >/dev/null 2>&1; then
            exit 0
        fi
        ;;
esac

# Skip fixup/squash prefix commits
if head -1 "$COMMIT_MSG_FILE" | grep -qE '^(fixup!|squash!|amend!)'; then
    exit 0
fi

# Build the Signed-off-by line from git's author identity
SOB=$(git var GIT_AUTHOR_IDENT | sed -n 's/^\(.*>\).*/Signed-off-by: \1/p')

# Add trailer only if not already present
if ! grep -qsF "$SOB" "$COMMIT_MSG_FILE"; then
    git interpret-trailers --in-place --trailer "$SOB" "$COMMIT_MSG_FILE"
fi

exit 0
