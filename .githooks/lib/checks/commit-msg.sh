#!/usr/bin/env bash
# Generic check: commit-msg. Copied from the shared hook template.
# Structure: a subject line, a blank line, then a body; log readers,
# changelogs and release notes depend on that shape.
# Convention: a Conventional Commits subject. Structure, convention and the
# DCO rules all live in
# lib/convention.sh, shared with the pre-push re-check. Every
# owned repository carries its own copy of this file, and the owner wants one
# uniform convention across all of them, so the rules are fixed here rather
# than chosen per repository. GIT_CONVENTION.md documents each rule.
# Safety net: the Signed-off-by trailer that prepare-commit-msg injects.
# This file keeps only what is commit-time specific: comment stripping, the
# exemptions for messages git writes or reuses, and the report.

set -euo pipefail

# shellcheck source-path=SCRIPTDIR source=../convention.sh
. "${BASH_SOURCE[0]%/*}/../convention.sh"

COMMIT_MSG_FILE="$1"
# `commit -v` appends the diff below this line, after the comment character;
# git drops it from the stored message, so the checks must not read it.
SCISSORS=' ------------------------ >8 ------------------------'
# The hook runs on every commit, so parsing stays in bash builtins: each
# awk, sed or grep process would add milliseconds to every commit.

CONVENTION_FOUND=''
reused=0

# has_text <line> -- true when the line holds more than spaces and tabs.
has_text() { [[ "$1" == *[!$' \t']* ]]; }

# text_lines <text> [skip-signoff] -- print the lines that hold text, so two
# messages compare equal whatever blank lines git or an editor added. With
# skip-signoff, Signed-off-by lines are dropped too.
text_lines() {
    local line out=''
    while IFS= read -r line || [ -n "$line" ]; do
        has_text "$line" || continue
        [ -n "${2:-}" ] && [[ "$line" == "$CONVENTION_SIGNOFF_PREFIX"* ]] && continue
        out+="$line"$'\n'
    done <<<"$1"
    printf '%s' "$out"
}

# git composes these messages itself: a merge summary carries no body of its
# own, and fixup/squash/amend placeholders are rewritten before they land.
case "${COMMIT_MSG_FILE##*/}" in
    MERGE_MSG) exit 0 ;;
esac
case "${GIT_REFLOG_ACTION:-}" in
    merge*) exit 0 ;;
esac

# The editor path leaves git's comment lines in the file until cleanup runs, so
# they must never be read as a subject or as a body. commentString is an alias
# of commentChar, and the later key wins; reading only commentChar misses a
# config that sets the alias. "auto" is chosen by git-commit per message and
# is not visible here, so it keeps the default.
comment_char=''
while IFS= read -r line; do
    comment_char=''
    [[ "$line" == *' '* ]] && comment_char="${line#* }"
done < <(git config --get-regexp '^core\.comment(char|string)$' 2>/dev/null || true)
case "$comment_char" in
    ''|auto) comment_char='#' ;;
esac

# LINES holds the message without comments; index 0 is the first line.
LINES=()
while IFS= read -r line || [ -n "$line" ]; do
    [ "$line" = "$comment_char$SCISSORS" ] && break
    [[ "$line" == "$comment_char"* ]] && continue
    LINES+=("$line")
done <"$COMMIT_MSG_FILE"
# Trailing blank lines are not part of the message, as in "$(cat file)".
while [ "${#LINES[@]}" -gt 0 ] && [ -z "${LINES[${#LINES[@]}-1]}" ]; do
    unset "LINES[${#LINES[@]}-1]"
done
MESSAGE=''
[ "${#LINES[@]}" -eq 0 ] || printf -v MESSAGE '%s\n' "${LINES[@]}"
MESSAGE="${MESSAGE%$'\n'}"

subject_index=-1
SUBJECT=''
for i in ${LINES[@]+"${!LINES[@]}"}; do
    if has_text "${LINES[$i]}"; then
        subject_index="$i"
        SUBJECT="${LINES[$i]}"
        break
    fi
done

# A message git already carries is reused rather than authored now, so its
# structure must not be re-judged. Amend and --reuse-message of HEAD match
# HEAD exactly, including the trailer, and are left untouched. Cherry-pick
# --continue also runs this hook, but it does not set GIT_REFLOG_ACTION; the
# message it carries is the one on CHERRY_PICK_HEAD. prepare-commit-msg adds
# Signed-off-by on that path, so the trailer is ignored for the comparison.
# The DCO checks below still run, because pre-push rejects a replay that lacks
# the trailer. Default cherry-pick does not run this hook. --reuse-message of
# some other commit is not visible here. pre-push re-checks the convention of
# every pushed commit, reused or not.
if [ -n "$SUBJECT" ]; then
    trimmed="$(text_lines "$MESSAGE")"
    head_message="$(git log -1 --format=%B HEAD 2>/dev/null || true)"
    if [ -n "$trimmed" ] && [ -n "$head_message" ] &&
        [ "$trimmed" = "$(text_lines "$head_message")" ]; then
        exit 0
    fi
    picked="$(git log -1 --format=%B CHERRY_PICK_HEAD 2>/dev/null || true)"
    if [ -n "$picked" ]; then
        picked_text="$(text_lines "$picked" skip-signoff)"
        file_text="$(text_lines "$MESSAGE" skip-signoff)"
        if [ -n "$file_text" ] && [ "$file_text" = "$picked_text" ]; then
            reused=1
        fi
    fi
fi

# Placeholders are folded away by `rebase --autosquash` before a push, and
# pre-push rejects any that remain.
for prefix in "${CONVENTION_AUTOSQUASH_PREFIXES[@]}"; do
    [[ "$SUBJECT" == "$prefix"* ]] && exit 0
done

# Structure and convention are skipped for an unedited cherry-pick
# continuation. The DCO checks below still run.
if [ "$reused" -eq 0 ]; then
    convention_structure "$MESSAGE"
    if [ -n "$SUBJECT" ]; then
        convention="$(convention_violations "$MESSAGE" commit)" ||
            CONVENTION_FOUND+="$convention"$'\n'
    fi
fi
convention_dco "$MESSAGE"

if [ "${CONVENTION_BODY_ESCAPE:-0}" -eq 1 ]; then
    echo >&2 "⚠ commit-msg: literal escape sequence in the body; line breaks are real newlines."
fi

if [ -n "$CONVENTION_FOUND" ]; then
    echo >&2 "❌ Commit rejected — commit message breaks the convention:"
    convention_report "$CONVENTION_FOUND"
    cat >&2 <<'GUIDANCE'
   Expected: 'type(scope): summary', a blank line, then a body. Pass the body
   with a second -m flag, for example
   git commit -s -S -m 'fix(parser): keep empty lines' -m 'why this change exists'.
   Shell arguments keep \n as literal text, so type real line breaks instead.
GUIDANCE
    exit 1
fi

exit 0
