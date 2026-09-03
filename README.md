# Herdr Pickers

Mouse-aware, fzf-ranked Herdr pickers for projects, workspaces, worktrees,
and agents. Every interactive mode opens in a centered Herdr popup sized to
75% of the terminal in each dimension. The plugin also owns
previous-workspace history because Herdr has no native last-focused-
workspace action.

## Requirements

- Herdr `>= 0.8.0` (`popup.close` socket API)
- Bun `>= 1.3`
- fzf `>= 0.48`
- Git
- macOS or Linux; Windows is out of scope

Tested on macOS with Ghostty `1.3.1` and Herdr `0.8.2`. Linux is exercised
by this repository's PTY smoke suite in CI.

## Install

```sh
herdr plugin install sagmans/herdr-pickers
```

Pin a specific revision with `--ref`:

```sh
herdr plugin install sagmans/herdr-pickers --ref v0.1.0
```

Installing registers the plugin and its actions. It does not change any
Herdr keybindings — bind what you want, as shown below.

## Optional keybindings

Add entries to Herdr's `config.toml` (`[[keys.command]]`, type `shell`):

```toml
[[keys.command]]
key = "prefix+s"
type = "shell"
command = "herdr plugin action invoke herdr-pickers.workspaces"

[[keys.command]]
key = "prefix+shift+s"
type = "shell"
command = "herdr plugin action invoke herdr-pickers.repo-workspaces"

[[keys.command]]
key = "prefix+w"
type = "shell"
command = "herdr plugin action invoke herdr-pickers.worktrees"

[[keys.command]]
key = "prefix+shift+w"
type = "shell"
command = "herdr plugin action invoke herdr-pickers.repo-worktrees"

[[keys.command]]
key = "prefix+shift+p"
type = "shell"
command = "herdr plugin action invoke herdr-pickers.projects"

[[keys.command]]
key = "prefix+a"
type = "shell"
command = "herdr plugin action invoke herdr-pickers.agents"

[[keys.command]]
key = "prefix+shift+a"
type = "shell"
command = "herdr plugin action invoke herdr-pickers.repo-agents"

[[keys.command]]
key = "prefix+shift+l"
type = "shell"
command = "herdr plugin action invoke herdr-pickers.all"

[[keys.command]]
key = "prefix+u"
type = "shell"
command = "herdr plugin action invoke herdr-pickers.last-workspace"
```

## Actions

| Action | Purpose |
|---|---|
| `herdr-pickers.all` | Search projects, workspaces, and worktrees by repository. |
| `herdr-pickers.projects` | Search tracked or configured repositories. |
| `herdr-pickers.workspaces` | Search actionable non-bare workspaces. |
| `herdr-pickers.repo-workspaces` | Search workspaces in the invoking repository. |
| `herdr-pickers.worktrees` | Search worktrees across tracked repositories. |
| `herdr-pickers.repo-worktrees` | Search worktrees in the invoking repository. |
| `herdr-pickers.agents` | Search every agent Herdr tracks. |
| `herdr-pickers.repo-agents` | Search agents in the invoking repository. |
| `herdr-pickers.last-workspace` | Toggle to the previously focused workspace. |

## Project discovery

Project discovery configuration is optional:

```sh
herdr plugin config-dir herdr-pickers
```

When `[projects].roots` is empty, project and global worktree modes mirror
repositories already tracked by Herdr. Set explicit parent roots to include
repositories not yet opened in Herdr:

```toml
[projects]
roots = ["~/projects", "~/work"]
```

## Picker controls

| Input | Action |
|---|---|
| typing | Fuzzy search visible repository, identity, relation, and detail text |
| `Ctrl-n` / `↓` | Move selection down |
| `Ctrl-p` / `↑` | Move selection up |
| `Enter` / `Ctrl-j` | Dispatch highlighted target |
| mouse click | Move selection |
| mouse double-click | Dispatch clicked target |
| mouse wheel | Scroll |
| `Esc` | Clear search; close when search is empty |
| `Ctrl-C` | Close |
| `Ctrl-r` | Reload the current catalog without closing |
| `Backspace` | Delete the previous search character |

Configure keyboard actions in the plugin `config.toml` shown by
`herdr plugin config-dir herdr-pickers`:

```toml
[keymap]
up = ["up", "ctrl-k"]
down = ["down", "ctrl-j"]
```

Each action accepts an array of keys, so one action can keep multiple
bindings. A configured action replaces only that action's defaults. Omitted
actions keep their defaults. In the example, `Ctrl-j` moves down, while the
carriage return sent by `Enter` still accepts. Use an empty array to unbind
an action.

Configurable actions are `up`, `down`, `accept`, `escape`, `close`, and
`reload`. Supported key names are `up`, `down`, `enter`, `escape`, and
`ctrl-a` through `ctrl-z`. Printable characters remain search input, and
`Backspace` remains fixed query editing. Unknown names, malformed arrays, and
conflicting keys fail with the config file path. Reopen the popup after a
config change.

Terminals encode `Ctrl-j` as line feed. A terminal that also sends line feed
for `Enter` cannot distinguish those inputs. Use carriage-return `Enter` or a
different binding there.

The top-right `✕` closes without dispatch. Cancellation is inert. Dispatch
failures close the popup and surface as errors.

Navigation catalogs reload only on `Ctrl-r`, preventing project and Git
worktree discovery from polling. Agent catalogs refresh every second and also
support `Ctrl-r`. Empty navigation catalogs remain open and reloadable;
empty agent catalogs do not open a popup.

Search uses only rendered group, identity, relation, badge, and detail text.
Hidden paths, workspace ids, agent targets, and workspace agent status do
not enter the search corpus.

## Rows and dispatch

Repository modes group rows under cyan headers. `all` uses green project,
cyan workspace, and magenta worktree badges and identities. Dedicated
navigation modes omit badges. Projects remain flat. Duplicate repository
names and otherwise-identical workspace labels gain only the shortest unique
path suffix required for distinction.

Workspace and worktree modes include the invoking source, marked with a `●`
current marker and preselected; selecting it re-focuses its workspace.
Selecting an open target focuses its existing workspace. Selecting an
unopened project creates and focuses a workspace. Selecting an unopened
linked worktree asks Herdr to open it; direct workspace creation is a
fallback only when Herdr reports missing or unlinked worktree metadata.

Agent rows nest beneath repository headers. Status marks mirror Herdr:
`●` blocked (red), `●` working (yellow), `●` done (cyan), `○` idle (green),
and `·` unknown (gray). The agent running in the invoking pane is
preselected (pane-id based; Herdr's focused flags are only a fallback).

Every picker preselects the currently opened item on open. Typing always
moves the pointer to the best match (first ranked row); clearing the query
returns it to the current item. Live reloads preserve pointer position.

## Previous workspace

`workspace.focused` records current and previous workspace ids in atomic
state under Herdr's `herdr-pickers` state directory. `workspace.closed`
prunes closed ids and automatically focuses the previous workspace when the
currently focused workspace is closed. Repeated toggling switches between
two live workspaces; the first press from empty state only seeds current
focus. Delayed focus events and stale workspace ids are ignored.

## Update, uninstall, and development

```sh
# reinstall / update to the default branch
herdr plugin install sagmans/herdr-pickers

# uninstall (plugin config and state directories are preserved by Herdr)
herdr plugin uninstall herdr-pickers

# local development: link a checkout instead of installing
git clone https://github.com/sagmans/herdr-pickers
cd herdr-pickers
bun install
herdr plugin link .
```

Run the checks:

```sh
bun test
bun run typecheck
bun run smoke   # PTY smoke against a disposable isolated Herdr runtime
```

The smoke automates dispatch, toggling, reload, and teardown, but two
behaviors only a human can verify: mouse click/double-click/wheel selection
and visual fidelity in a real terminal emulator. Give both a quick pass in a
disposable session before trusting a release.

## Trust

Herdr plugins run unsandboxed as your user. This plugin invokes only the
Herdr CLI, fzf, and Git. It performs no network requests, collects no
telemetry, and ships no runtime npm dependencies. Untrusted text such as
repository names, branch names, and child-process output is sanitized
before it can reach your terminal.

## Troubleshooting

- `HERDR_PLUGIN_ID is required` — invoke through Herdr, not by running the open entrypoint directly.
- No `herdr-pickers.*` actions — reinstall or `herdr plugin link .` from a checkout.
- No projects or worktrees — open a repository in Herdr or configure `[projects].roots`.
- No agents — open an agent pane first.
- Red fzf error — verify `fzf --version` is `>= 0.48`.

## License

MIT — see [LICENSE](LICENSE). The bundled Tokyo Night-derived palette is
covered by its own MIT notice in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
