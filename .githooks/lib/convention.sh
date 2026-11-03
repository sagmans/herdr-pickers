#!/usr/bin/env bash
# shellcheck shell=bash
# Commit convention rules shared by the commit-msg hook (lib/checks/commit-msg.sh)
# and the pre-push re-check (lib/checks/push.sh). Copied from the shared hook
# template.
# One sourced file holds the rules so that a message judged at commit time is
# judged the same way at push time: a commit made with hooks off, or reworded
# later, meets the same bar before it leaves the machine. Every rule here is
# described, with examples, in GIT_CONVENTION.md next to the hooks.
# Pure bash with no subprocesses, because commit-msg runs on every commit.
# Message structure (convention_structure) and the DCO trailer
# (convention_dco) live here too, so a commit made with hooks off cannot skip
# the body or the sign-off that commit-msg asks for.

# Where a contributor reads the rules; every rejection points here.
CONVENTION_DOC='.githooks/GIT_CONVENTION.md'
# The owner wants one convention across all owned repositories, so the list
# is fixed here instead of per repository.
CONVENTION_TYPES='feat fix docs style refactor perf test build ci chore revert'
# Longer subjects are cut off by `git log --oneline`, hosting sites and mail.
CONVENTION_SUBJECT_MAX=72
# Subjects that `git revert` writes itself; they quote the reverted subject,
# so they can neither start with a type nor stay inside the length limit.
CONVENTION_GIT_REVERT_PREFIXES=('Revert "' 'Reapply "')
# Placeholders that `git rebase --autosquash` folds away. Fine while working
# locally, but a pushed one stays in history for good.
CONVENTION_AUTOSQUASH_PREFIXES=('fixup! ' 'squash! ' 'amend! ')
# Work-in-progress markers, matched without regard to letter case.
CONVENTION_WIP_RE='^\[?wip([^[:alnum:]]|$)'
# Type, optional scope without spaces or parentheses, optional breaking-change
# mark, then ": " and the summary. The summary is checked separately so the
# message can say which part is wrong.
CONVENTION_HEADER_RE='^([A-Za-z]+)(\([^()[:space:]]+\))?(!)?:(.*)$'
# A caller passing 'subject\nbody' to `git commit -m` writes one long line
# with literal escapes instead of lines.
CONVENTION_ESCAPE_RE='\\[nrtv]'
# Trailer lines ("Key: value") are not body text.
CONVENTION_TRAILER_RE='^[A-Za-z][A-Za-z0-9-]*: '
CONVENTION_BLANK_RE='^[[:space:]]*$'
CONVENTION_SIGNOFF_PREFIX='Signed-off-by: '

# _convention_add <rule> <problem> <fix> -- append to CONVENTION_FOUND in the
# format convention_report reads. A global, not output, so commit-msg needs
# no subshell per rule.
_convention_add() { CONVENTION_FOUND+="[$1] $2"$'\n'"fix: $3"$'\n'; }

# convention_structure <message>
# Append the broken structure rules to CONVENTION_FOUND: a subject, a blank
# second line, a body that is more than trailers, no trailing space in the
# subject, no literal escape in it, no carriage return. Sets
# CONVENTION_BODY_ESCAPE=1 when a body line holds a literal escape (allowed,
# but commit-msg warns). The same rules apply at commit and at push.
# shellcheck disable=SC2034  # CONVENTION_BODY_ESCAPE is read by commit-msg
convention_structure() {
    local message="$1" lines=() line subject='' subject_index=-1 i body_lines=0
    CONVENTION_BODY_ESCAPE=0
    while IFS= read -r line || [ -n "$line" ]; do
        lines+=("$line")
    done <<<"$message"
    for ((i = 0; i < ${#lines[@]}; i++)); do
        case "${lines[$i]}" in
            *[![:space:]]*)
                subject_index="$i"
                subject="${lines[$i]}"
                break
                ;;
        esac
    done

    if [ -z "$subject" ]; then
        _convention_add subject-missing "missing subject: the first non-comment line must not be blank" \
            "write a subject line first"
    else
        if [[ "$subject" =~ $CONVENTION_ESCAPE_RE ]]; then
            _convention_add escape-sequence "subject contains a literal escape sequence such as \\n" \
                "pass the body as a second -m instead of typing \\n"
        fi
        case "$subject" in
            *[[:space:]]) _convention_add subject-trailing-space "subject has trailing whitespace" \
                "remove the spaces at the end of the subject" ;;
        esac
        # Editor cleanup turns a whitespace-only separator into a blank line
        # only after commit-msg runs, so that line already counts as blank.
        case "${lines[subject_index + 1]:-}" in
            *[![:space:]]*) _convention_add blank-line "missing blank line between subject and body" \
                "leave the second line empty" ;;
        esac
        for ((i = subject_index + 2; i < ${#lines[@]}; i++)); do
            line="${lines[$i]}"
            [[ "$line" =~ $CONVENTION_ESCAPE_RE ]] && CONVENTION_BODY_ESCAPE=1
            [[ "$line" =~ $CONVENTION_BLANK_RE || "$line" =~ $CONVENTION_TRAILER_RE ]] && continue
            body_lines=$((body_lines + 1))
        done
        if [ "$body_lines" -eq 0 ]; then
            _convention_add body-required "missing body: state why the change exists" \
                "add a body that explains why, for example with a second -m"
        fi
    fi

    if [[ "$message" == *$'\r'* ]]; then
        _convention_add carriage-return "message contains a carriage return" \
            "write the message with Unix line endings"
    fi
}

# convention_dco <message> -- append to CONVENTION_FOUND when the message has
# no Signed-off-by line, or the same one twice. Merges are judged too: git
# writes their text, but the sign-off is still a claim the author makes.
convention_dco() {
    local line signoffs=() duplicates='' i j
    while IFS= read -r line || [ -n "$line" ]; do
        [[ "$line" == "$CONVENTION_SIGNOFF_PREFIX"* ]] && signoffs+=("$line")
    done <<<"$1"
    if [ "${#signoffs[@]}" -eq 0 ]; then
        _convention_add signed-off-by "missing 'Signed-off-by' line" \
            "run scripts/setup-hooks, or commit with -s"
        return
    fi
    # A handful of trailers at most, so a pairwise scan is cheap.
    for ((i = 0; i < ${#signoffs[@]}; i++)); do
        for ((j = i + 1; j < ${#signoffs[@]}; j++)); do
            if [ "${signoffs[$i]}" = "${signoffs[$j]}" ] && [[ "$duplicates" != *"${signoffs[$i]} "* ]]; then
                duplicates+="${signoffs[$i]} "
            fi
        done
    done
    if [ -n "$duplicates" ]; then
        _convention_add duplicate-signoff "duplicate 'Signed-off-by' lines: $duplicates" \
            "keep exactly one Signed-off-by line per person"
    fi
}

# convention_violations <message> <mode>
# Print one "[rule] problem" line, then one "fix: ..." line, per broken rule.
# <mode> is commit or push; push also rejects the autosquash and WIP subjects
# that are allowed while a branch is still local. Returns 1 if a rule broke.
convention_violations() {
    local message="$1" mode="$2" subject='' line prefix type summary types_alt rc=0

    # The first non-blank line is the subject, as git and log readers see it.
    while IFS= read -r line; do
        case "$line" in *[![:space:]]*) subject="$line"; break ;; esac
    done <<<"$message"

    if [ "$mode" = push ]; then
        for prefix in "${CONVENTION_AUTOSQUASH_PREFIXES[@]}"; do
            if [[ "$subject" == "$prefix"* ]]; then
                printf '%s\n' "[no-autosquash] '${prefix% }' commit must not be pushed" \
                    "fix: fold it into its target with git rebase -i --autosquash <base>"
                return 1
            fi
        done
        if _convention_nocase_match "$subject" "$CONVENTION_WIP_RE"; then
            printf '%s\n' "[no-wip] work-in-progress commit must not be pushed" \
                "fix: finish the work, then squash or reword it with git rebase -i <base>"
            return 1
        fi
    fi

    for prefix in "${CONVENTION_GIT_REVERT_PREFIXES[@]}"; do
        [[ "$subject" == "$prefix"* ]] && return "$rc"
    done

    types_alt="${CONVENTION_TYPES// /|}"
    if [[ "$subject" =~ $CONVENTION_HEADER_RE ]]; then
        type="${BASH_REMATCH[1]}"
        summary="${BASH_REMATCH[4]}"
        if ! [[ "$type" =~ ^($types_alt)$ ]]; then
            printf '%s\n' "[subject-type] type '$type' is not allowed" \
                "fix: use one of: $CONVENTION_TYPES (lower case)"
            rc=1
        fi
        if ! [[ "$summary" =~ ^\ [^[:space:]] ]]; then
            printf '%s\n' "[subject-summary] missing summary after '${subject%%:*}:'" \
                "fix: write one space after the colon, then a short summary"
            rc=1
        fi
    else
        printf '%s\n' "[subject-type] subject must look like 'type(scope)!: summary'" \
            "fix: for example 'fix(parser): keep empty lines'; types: $CONVENTION_TYPES"
        rc=1
    fi

    if [ "${#subject}" -gt "$CONVENTION_SUBJECT_MAX" ]; then
        printf '%s\n' "[subject-length] subject is ${#subject} characters, limit is $CONVENTION_SUBJECT_MAX" \
            "fix: shorten the summary and move details to the body"
        rc=1
    fi

    case "$subject" in
        *.)
            printf '%s\n' "[subject-period] subject ends with a period" \
                "fix: remove the final period"
            rc=1
            ;;
    esac
    return "$rc"
}

# A bash regex match without regard to letter case that leaves the caller's
# nocasematch setting as it was.
_convention_nocase_match() {
    local text="$1" re="$2" was=0 rc=1
    shopt -q nocasematch && was=1
    shopt -s nocasematch
    [[ "$text" =~ $re ]] && rc=0
    [ "$was" -eq 1 ] || shopt -u nocasematch
    return "$rc"
}

# convention_report <violations> -- print the lines from convention_violations
# indented under a rejection header, then the pointer to the rules.
convention_report() {
    local line
    while IFS= read -r line; do
        [ -n "$line" ] || continue
        case "$line" in
            fix:*) echo >&2 "     $line" ;;
            *) echo >&2 "   - $line" ;;
        esac
    done <<<"$1"
    echo >&2 "   Rules and examples: $CONVENTION_DOC (each [rule] is a section there)"
}
