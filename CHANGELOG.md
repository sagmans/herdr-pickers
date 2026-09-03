# Changelog

All notable user-facing changes to Herdr Pickers are recorded in this file.

## [Unreleased]

### Added

- Added configurable multi-key bindings for picker navigation and actions.

## [0.1.0] - 2026-09-02

### Added

- Added fzf-ranked popup pickers for projects, workspaces, worktrees, and agents.
- Added repository-scoped picker modes and one combined navigation mode.
- Added keyboard and mouse controls, live agent refresh, manual catalog reload, and current-target selection.
- Added configurable project roots and Herdr-backed project discovery.
- Added previous-workspace history with locked, atomic state.
- Added macOS and Linux support with pinned tools, CI, audits, and an isolated PTY smoke test.

### Security

- Sanitized untrusted terminal text, bounded child-process errors, and kept command execution argv-based.
- Added private vulnerability reporting guidance, license terms, and third-party notices.

[Unreleased]: https://github.com/sagmans/herdr-pickers/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/sagmans/herdr-pickers/releases/tag/v0.1.0
