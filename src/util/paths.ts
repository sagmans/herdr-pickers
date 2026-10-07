// Path identity for repository and workspace matching. Herdr, Git, and config
// report the same directory through symlinks or relative forms, so comparisons
// go through one canonical key.
import { realpathSync } from "node:fs";
import { resolve, sep } from "node:path";

/** Real path when it exists; a missing path still yields a stable resolved key instead of failing. */
export function canonicalPathKey(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

// Ancestry instead of equality so a repo row stays current while the user
// works anywhere inside it (subdirectories, linked worktree checkouts).
export function isPathWithin(path: string, cwd: string): boolean {
  const root = canonicalPathKey(path);
  const inner = canonicalPathKey(cwd);
  if (inner === root) return true;
  return inner.startsWith(root.endsWith(sep) ? root : root + sep);
}