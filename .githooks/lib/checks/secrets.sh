#!/usr/bin/env bash
# Generic check: secret scan with gitleaks. Copied from the dotf template
# (templates/githooks). A leaked key cannot be taken back once pushed, so
# the scan runs on the staged change (pre-commit) and again on every pushed
# commit (pre-push), which also covers commits made without hooks.
# Usage: secrets.sh staged | secrets.sh range <git rev-list args...>
# A missing scanner fails the hook: an unscanned push is not a passed one.

set -euo pipefail

SCANNER=gitleaks
INSTALL_HINT='install gitleaks (https://github.com/gitleaks/gitleaks), e.g. brew install gitleaks or mise use gitleaks'

if ! command -v "$SCANNER" >/dev/null 2>&1; then
	echo >&2 "❌ secret scan: $SCANNER not found; $INSTALL_HINT"
	exit 1
fi

mode="${1:-}"
shift || true
case "$mode" in
staged)
	# git exports GIT_INDEX_FILE for the commit, so the scan sees exactly
	# what is being committed, including `commit -a` and `commit <paths>`.
	"$SCANNER" git --pre-commit --staged --redact --no-banner --log-level warn .
	;;
range)
	"$SCANNER" git --log-opts="$*" --redact --no-banner --log-level warn .
	;;
*)
	echo >&2 "secrets.sh: usage: secrets.sh staged | secrets.sh range <rev-list args>"
	exit 2
	;;
esac
