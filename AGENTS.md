# AGENTS.md

## Project boundary

Herdr Pickers is a Bun/TypeScript Herdr plugin. Herdr runs it unsandboxed as the current user, directly from TypeScript; there is no build step and no runtime npm dependency.

Use [README.md](README.md) for user-facing behavior and [SECURITY.md](SECURITY.md) for private vulnerability reporting. Follow [RELEASE.md](RELEASE.md) for every release.

## Repository map

- `herdr-plugin.toml`: public actions, events, popup geometry, platform support, and runtime entrypoints.
- `src/actions/` and `src/pane.ts`: Herdr entrypoints and popup lifecycle.
- `src/picker.ts` and `src/navigation.ts`: mode orchestration and catalog loading.
- `src/client/`: Herdr command and JSON compatibility boundary.
- `src/catalog.ts`, `src/rows.ts`, and `src/terminal-picker.ts`: target normalization, visible/searchable rows, and terminal interaction.
- `src/dispatch.ts`: selection dispatch for navigation and agent targets.
- `src/last-workspace/`: locked, atomic previous-workspace state.
- `tests/`: Bun tests mirroring source behavior; `scripts/smoke.ts` is the isolated real-Herdr PTY test.

## Commands

Use tool versions from `mise.toml`:

```sh
mise install
bun install --frozen-lockfile
```

Run one test file while iterating:

```sh
bun test tests/<module>.test.ts
```

Match the pull-request CI gate before handoff:

```sh
bun test
bun run typecheck
bun audit
```

Run `bun run smoke` for changes to plugin registration, Herdr commands or JSON, popup/TTY behavior, discovery, dispatch, events, or persisted workspace state. It requires the tools in `mise.toml` plus `python3`.

## Change constraints

- Keep `herdr-plugin.toml`, `package.json`, README action documentation, and `tests/manifest.test.ts` aligned when public plugin metadata or entrypoints change.
- Use explicit `.ts` extensions for local imports. Keep discriminated-union and enum switches exhaustive with a `never` default.
- Parse external Herdr JSON in `src/client/types.ts`. Treat fields as untrusted and preserve compatibility fallbacks unless the supported Herdr contract changes.
- Route every repository name, branch, label, child-process message, and other untrusted terminal string through `src/util/terminal-text.ts`. Visible/searchable rows must not expose hidden ids or paths.
- Preserve terminal cleanup on success, cancellation, signals, and failures: raw mode, mouse tracking, cursor, wrapping, and alternate-screen state must be restored.
- Keep navigation catalogs reload-on-demand. Only agent catalogs poll, currently through the picker refresh path.
- Preserve atomic writes and locking for previous-workspace state; event-hook failures must not break workspace close behavior.
- Keep child-process invocation argv-based. Do not introduce shell interpolation for paths, labels, ids, or queries.
- Keep runtime `dependencies` absent unless the plugin trust model, notices, documentation, and manifest tests are intentionally revised.

## Smoke and release safety

`scripts/smoke.ts` redirects all four XDG base directories, removes inherited `HERDR_*` routing, and verifies the temporary socket path before any Herdr mutation. Preserve those gates. A named Herdr session alone does not isolate the shared plugin registry; never test with manual `herdr plugin link`, `unlink`, or `install` against host configuration.

The automated smoke does not prove mouse click, double-click, wheel behavior, or visual fidelity. Before release, exercise those paths in a disposable real terminal session and confirm cleanup leaves the terminal usable.
