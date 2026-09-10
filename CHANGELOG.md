# Changelog

All notable user-facing changes to Herdr Pickers are recorded in this file.

## [Unreleased]

## [0.3.0] - 2026-09-10

### Added

- Added a `placement` setting so pickers can open as overlay and hide Kitty images from the pane underneath.

### Fixed

- Overlay rendering no longer waits for focus setup; native snapshot requests reduce acceptance delays.
- Accepted selections keep their last frame through focus checks and dispatch instead of exposing an empty picker.
- Large session snapshots no longer make overlays close immediately; focus events retain their smaller message limit.
- New picker actions replace the current mode in place and reset search. The newest session request wins across all eight modes and both placements.
- Mode replacement cancels obsolete work without restoring a blank screen or dispatching stale selections. Repository actions retain their original source context.
- Startup bursts and requests during dismissal converge on one owner or verified successor. Delivery times out rather than opening an uncertain duplicate.
- Proven process-creation failures release unclaimed reservations so a later picker can retry safely.
- Agent discovery keeps terminal cancellation available during initial loading and mode replacement.
- Focus-observation failures report a nonzero exit status after cleanup instead of appearing as successful cancellation.
- Mode replacement preserves fresh text and Ctrl-C after fragmented keys, including split UTF-8 characters.
- Navigation away from an overlay cancels it without restoring the old focus or dispatching a selection.
- Cancellation interrupts pending picker work. Overlay teardown now retains the last frame during the bounded close request before restoring terminal state.
- Popup cleanup no longer risks closing a replacement popup.
- Overlay Escape and Ctrl-C now close the zoomed pane instead of leaving a blank terminal.
- Overlay cancel now removes the picker pane so it cannot linger in the mosaic.

## [0.2.0] - 2026-09-04

### Added

- Added configurable multi-key bindings for picker navigation and actions while keeping Escape and Ctrl-C fixed for reliable cancellation.

### Changed

- Navigation pickers now render before project and worktree discovery completes.

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

[Unreleased]: https://github.com/sagmans/herdr-pickers/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/sagmans/herdr-pickers/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/sagmans/herdr-pickers/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/sagmans/herdr-pickers/releases/tag/v0.1.0
