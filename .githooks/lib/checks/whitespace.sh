#!/usr/bin/env bash
# Generic check: whitespace errors and leftover conflict markers in the staged
# change. Copied from the shared hook template.
# A conflict marker that lands in a commit breaks the file for everyone who
# pulls it, and stray whitespace makes later diffs noisy. git already knows
# both rules (core.whitespace and the `whitespace` attribute), so the check
# asks git instead of keeping its own list, and a repo tunes it the git way,
# for example `*.md whitespace=-blank-at-eol` in .gitattributes.
# Reads the index git is committing (PROJECT_HOOK_INDEX_FILE, set by
# pre-commit), so `commit -a` and `commit <paths>` check what is committed.

set -euo pipefail

INDENT='   '

index="${PROJECT_HOOK_INDEX_FILE:?whitespace.sh: run from the pre-commit hook}"

# Exit status 2 means findings and anything else non-zero means git failed;
# both block, so a broken check never reads as a clean change.
if ! report="$(GIT_INDEX_FILE="$index" git diff --cached --check --no-color 2>&1)"; then
    echo >&2 "❌ Commit rejected — whitespace errors or conflict markers in the staged change:"
    printf '%s\n' "$report" | sed "s/^/$INDENT/" >&2
    cat >&2 <<'GUIDANCE'
   Fix: resolve every conflict marker, remove the trailing whitespace or extra
   blank lines shown above, then stage the files again.
GUIDANCE
    exit 1
fi
