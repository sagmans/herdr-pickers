#!/usr/bin/env bash
# Generic check: commit-msg. Copied from the dotf template (templates/githooks).
# Structural validation only: a subject line, a blank line, then a body.
# Convention-agnostic on purpose, because this hook is shared by every
# repository on the machine and their subject styles (types, scopes, length)
# differ; what all of them parse is the structure that log readers, changelogs,
# and release notes depend on.
# Escape sequences are rejected because a caller passing 'subject\nbody' to
# `git commit -m` writes one long line with literal escapes instead of lines.
# Safety net: the Signed-off-by trailer that prepare-commit-msg injects.

set -euo pipefail

COMMIT_MSG_FILE="$1"
ESCAPE_RE='\\[nrtv]'
TRAILER_RE='^[A-Za-z][A-Za-z0-9-]*: '

VIOLATIONS=''
body_escape=0
reused=0

add_violation() { VIOLATIONS+="   - $1"$'\n'; }

# git composes these messages itself: a merge summary carries no body of its
# own, and fixup/squash/amend placeholders are rewritten before they land.
case "$(basename "$COMMIT_MSG_FILE")" in
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
comment_char="$(
    git config --get-regexp '^core\.comment(char|string)$' 2>/dev/null |
        awk 'END { sub(/^[^[:space:]]+[[:space:]]+/, ""); print }' || true
)"
case "$comment_char" in
    ''|auto) comment_char='#' ;;
esac
MESSAGE="$(awk -v c="$comment_char" 'index($0, c) == 1 { next } { print }' "$COMMIT_MSG_FILE")"

subject_line="$(awk 'NF { print NR; exit }' <<<"$MESSAGE")"
SUBJECT=''
if [ -n "$subject_line" ]; then
    SUBJECT="$(sed -n "${subject_line}p" <<<"$MESSAGE")"
fi

# A message git already carries is reused rather than authored now, so its
# structure must not be re-judged. Amend and --reuse-message of HEAD match
# HEAD exactly, including the trailer, and are left untouched. Cherry-pick
# --continue also runs this hook, but it does not set GIT_REFLOG_ACTION; the
# message it carries is the one on CHERRY_PICK_HEAD. prepare-commit-msg adds
# Signed-off-by on that path, so the trailer is ignored for the comparison.
# The DCO checks below still run, because pre-push rejects a replay that lacks
# the trailer. Default cherry-pick does not run this hook. --reuse-message of
# some other commit is not visible here.
if [ -n "$SUBJECT" ]; then
    trimmed="$(awk 'NF' <<<"$MESSAGE")"
    head_message="$(git log -1 --format=%B HEAD 2>/dev/null || true)"
    if [ -n "$trimmed" ] && [ -n "$head_message" ] &&
        [ "$trimmed" = "$(awk 'NF' <<<"$head_message")" ]; then
        exit 0
    fi
    picked="$(git log -1 --format=%B CHERRY_PICK_HEAD 2>/dev/null || true)"
    if [ -n "$picked" ]; then
        picked_text="$(awk 'NF && $0 !~ /^Signed-off-by: /' <<<"$picked")"
        file_text="$(awk 'NF && $0 !~ /^Signed-off-by: /' <<<"$MESSAGE")"
        if [ -n "$file_text" ] && [ "$file_text" = "$picked_text" ]; then
            reused=1
        fi
    fi
fi

case "$SUBJECT" in
    'fixup! '* | 'squash! '* | 'amend! '*) exit 0 ;;
esac

# Structure is skipped for an unedited cherry-pick continuation. The DCO checks
# below still run.
if [ "$reused" -eq 0 ]; then
    if [ -z "$SUBJECT" ]; then
        add_violation "missing subject: the first non-comment line must not be blank"
    else
        if grep -qE "$ESCAPE_RE" <<<"$SUBJECT"; then
            add_violation "subject contains a literal escape sequence such as \\n; use --no-verify if that sequence is intentional"
        fi
        case "$SUBJECT" in
            *[[:space:]]) add_violation "subject has trailing whitespace" ;;
        esac

        # Editor cleanup turns a whitespace-only separator into a blank line only
        # after this hook, so that line already satisfies the required break.
        separator="$(sed -n "$((subject_line + 1))p" <<<"$MESSAGE")"
        case "$separator" in
            *[![:space:]]*) add_violation "missing blank line between subject and body" ;;
        esac

        body="$(sed -n "$((subject_line + 2)),\$p" <<<"$MESSAGE")"
        body_lines="$(awk -v t="$TRAILER_RE" '$0 !~ /^[[:space:]]*$/ && $0 !~ t { n++ } END { print n + 0 }' <<<"$body")"
        if [ "$body_lines" -eq 0 ]; then
            add_violation "missing body: state why the change exists"
        fi
        if grep -qE "$ESCAPE_RE" <<<"$body"; then
            body_escape=1
        fi
    fi

    if grep -q $'\r' <<<"$MESSAGE"; then
        add_violation "message contains a carriage return"
    fi
fi

if ! grep -q '^Signed-off-by: ' <<<"$MESSAGE"; then
    add_violation "missing 'Signed-off-by' line: run scripts/setup-hooks, or commit with -s"
fi

duplicates="$(grep '^Signed-off-by: ' <<<"$MESSAGE" | sort | uniq -d || true)"
if [ -n "$duplicates" ]; then
    add_violation "duplicate 'Signed-off-by' lines: $(tr '\n' ' ' <<<"$duplicates")"
fi

if [ "$body_escape" -eq 1 ]; then
    echo >&2 "⚠ commit-msg: literal escape sequence in the body; line breaks are real newlines."
fi

if [ -n "$VIOLATIONS" ]; then
    echo >&2 "❌ Commit rejected — message structure invalid:"
    printf '%s' "$VIOLATIONS" >&2
    cat >&2 <<'GUIDANCE'
   Expected: a subject line, a blank line, then a body. Pass the body with a
   second -m flag, for example
   git commit -s -S -m 'subject' -m 'why this change exists'.
   Shell arguments keep \n as literal text, so type real line breaks instead.
GUIDANCE
    exit 1
fi

exit 0
