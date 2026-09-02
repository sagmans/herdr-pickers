# Release process

## Distribution

Herdr Pickers is a source-only plugin. Herdr installs it from GitHub and runs its TypeScript files with Bun.

Users can install the current default branch:

```sh
herdr plugin install sagmans/herdr-pickers
```

Users can select a stable release with a tag:

```sh
herdr plugin install sagmans/herdr-pickers --ref v<version>
```

The [Herdr marketplace](https://herdr.dev/plugins/) discovers this repository automatically. The integration requires these items:

- The repository is public.
- The repository has the GitHub topic `herdr-plugin`.
- The default branch has a valid root `herdr-plugin.toml`.

The index refreshes every 30 minutes and after default-branch changes. A marketplace listing is not a security review. See the [marketplace documentation](https://herdr.dev/docs/marketplace/).

## Release baseline

The release surface includes these controls:

- `herdr-plugin.toml` defines the plugin version, Herdr requirement, platforms, actions, events, and popup pane.
- `package.json` and `herdr-plugin.toml` use the same version. `tests/manifest.test.ts` enforces this rule.
- `mise.toml`, `bun.lock`, and `bunfig.toml` pin tools and protect dependency installation.
- Pull-request CI runs tests, type checks, and `bun audit` on macOS and Linux.
- `scripts/smoke.ts` runs the plugin in an isolated Herdr runtime. The on-demand smoke workflow runs on macOS and Linux.
- `README.md`, `SECURITY.md`, `LICENSE`, and `THIRD_PARTY_NOTICES.md` define installation, trust, reporting, and license terms.

## Release procedure

Every release must use a dedicated release pull request.

1. Create a `release/v<version>` branch from the current `main` branch.
2. Update `CHANGELOG.md`. Move completed entries from `Unreleased` to a dated version section.
3. Update the version in `package.json` and `herdr-plugin.toml`.
4. If version references, requirements, notices, or user documentation changed, update them.
5. Run `bun install --frozen-lockfile`, `bun test`, `bun run typecheck`, and `bun audit`.
6. If the release changes runtime behavior, run `bun run smoke`.
7. Run the smoke workflow. It tests both supported platforms.
8. Test mouse input and visual output in a disposable real terminal session.
9. Get approval for the release pull request.
10. When all checks pass, squash-merge the release pull request.
11. Update the local `main` branch.
12. Create the annotated `v<version>` tag at the release merge commit.
13. Push the tag.
14. Create a GitHub Release from the tag. Use the matching `CHANGELOG.md` section for its notes.
15. Make sure that the tag, GitHub Release, pinned install command, and marketplace metadata show the same version.

Create the tag and GitHub Release only after the release pull request merges. Never move or replace a published release tag.
