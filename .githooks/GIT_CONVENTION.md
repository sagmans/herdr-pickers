# Git commit convention

This file is the one source for the commit message rules that the hooks in
`.githooks/` enforce. It is copied from the shared hook template with the
hooks, so every owned repository uses the same rules.

- `commit-msg` checks each message when you commit.
- `pre-push` checks each new commit again before it leaves the machine. This
  also catches commits made with hooks off or reworded later.

Each rejection names a rule in square brackets, for example `[subject-type]`.
Each rule below has a section with the same name.

## Message shape

```text
type(scope)!: summary

Body: why the change exists. Wrap lines at about 72 characters.

Signed-off-by: Your Name <you@example.com>
```

Commit from the shell with one `-m` for the subject and one for the body:

```sh
git commit -s -S -m 'fix(parser): keep empty lines' -m 'Why the change exists.'
```

## Subject rules

Checked by `commit-msg` and again by `pre-push`.

### subject-type

The subject starts with a type, an optional scope in parentheses, an optional
`!` for a breaking change, then a colon and one space.

Allowed types, lower case only:
`feat fix docs style refactor perf test build ci chore revert`.

| Good | Bad |
| --- | --- |
| `feat(hooks): scan workflows before push` | `feature: scan workflows` |
| `fix: keep empty lines` | `Fix: keep empty lines` |
| `refactor(api)!: drop the v1 routes` | `update stuff` |
| `chore(deps/npm): bump lodash` | `feat(two words): add a thing` |

### subject-summary

A short summary follows the colon and one space.

| Good | Bad |
| --- | --- |
| `docs: explain the release steps` | `docs:` |
| `docs: explain the release steps` | `docs:explain the release steps` |

### subject-length

The subject has at most 72 characters. Longer subjects are cut off in
`git log --oneline` and on hosting sites. Move details to the body.

### subject-period

The subject does not end with a period.

| Good | Bad |
| --- | --- |
| `fix: keep empty lines` | `fix: keep empty lines.` |

### subject-missing

The first line that is not a comment must hold the subject.

### subject-trailing-space

The subject has no spaces at its end.

### escape-sequence

The subject has no literal `\n`, `\r`, `\t` or `\v`. They appear when a shell
passes `'subject\nbody'` to one `-m`. Pass the body as a second `-m`. The
body may hold such a sequence; `commit-msg` only warns about it there.

## Body and trailer rules

Checked by `commit-msg` and again by `pre-push`.

### blank-line

The second line is empty, so tools can split the subject from the body.

### body-required

A body follows the blank line. It says why the change exists, not what the
diff shows.

### carriage-return

The message uses Unix line endings only.

### signed-off-by

The message has a `Signed-off-by` trailer (DCO). `scripts/setup-hooks` turns
on the hook that adds it; `git commit -s` adds it too.

### duplicate-signoff

Each `Signed-off-by` line appears only once.

## Push-only rules

Checked by `pre-push` only. They are allowed while a branch is still local.

### no-autosquash

No pushed subject starts with `fixup!`, `squash!` or `amend!`. Fold them into
their target first:

```sh
git rebase -i --autosquash origin/main
```

### no-wip

No pushed subject starts with `WIP`, `wip:` or `[WIP]`, in any letter case.
Finish the work, then squash or reword the commit with `git rebase -i`.

## Exemptions

git writes some messages itself. The hooks do not judge them:

- merge commits (at commit time and at push time). At push time a merge
  still needs its `Signed-off-by` line;
- an amend or `--reuse-message` that keeps the message of `HEAD` unchanged;
- an unedited `git cherry-pick --continue`;
- subjects that `git revert` writes, which start with `Revert "` or
  `Reapply "`;
- `fixup!`, `squash!` and `amend!` subjects at commit time (not at push time).

`pre-push` still checks every rule on a reused or cherry-picked message.

## Fix a rejected commit

| Where | Fix |
| --- | --- |
| At commit | Change the message and commit again. |
| Last commit, not pushed | `git commit --amend`, then push. |
| Older commit, not pushed | `git rebase -i <base>`, mark it `reword`, then push. |

Do not use `--no-verify` to get past a rule: `pre-push` checks every rule
above again.
