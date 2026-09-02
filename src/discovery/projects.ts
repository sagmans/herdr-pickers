import { readdirSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";

export function listProjects(roots: readonly string[]): string[] {
  const projects = new Set<string>();

  for (const root of new Set(roots)) {
    if (isProject(root)) projects.add(realpathSync(root));
    for (const child of safeChildren(root)) {
      if (isProject(child)) projects.add(realpathSync(child));
    }
  }

  return [...projects].sort((left, right) => left.localeCompare(right));
}

function safeChildren(root: string): string[] {
  try {
    return readdirSync(root).map((name) => join(root, name));
  } catch {
    return [];
  }
}

function isProject(path: string): boolean {
  try {
    if (!statSync(path).isDirectory()) return false;
    return hasGitCheckoutMetadata(path) || isBareRepository(path);
  } catch {
    return false;
  }
}

function hasGitCheckoutMetadata(path: string): boolean {
  try {
    statSync(join(path, ".git"));
    return true;
  } catch {
    return false;
  }
}

export function isBareRepository(path: string): boolean {
  if (hasGitCheckoutMetadata(path)) return false;
  try {
    return statSync(join(path, "HEAD")).isFile()
      && statSync(join(path, "objects")).isDirectory()
      && statSync(join(path, "refs")).isDirectory();
  } catch {
    return false;
  }
}
