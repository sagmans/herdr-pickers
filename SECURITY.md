# Security policy

## Reporting a vulnerability

Do not open public issues for security problems. Use GitHub's private
vulnerability reporting on this repository instead:

1. Open the repository on GitHub.
2. Go to the **Security** tab.
3. Select **Report a vulnerability**.

Include reproduction steps and the affected version. Expect an initial
response within a few days.

## Scope

This plugin runs unsandboxed as your user inside Herdr and invokes only the
Herdr CLI, fzf, and Git. Reports about terminal-control injection, path or
secret leakage through picker output, or unsafe child-process handling are
in scope.
