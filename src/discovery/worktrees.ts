import { Herdr, HerdrCommandError, type CommandRunner } from "../client/herdr.ts";
import { readWorktrees, type WorktreeListResult, type WorktreeRecord } from "../client/types.ts";
import type { CurrentContext } from "../catalog.ts";

const GIT_COMMAND = "git";

export async function listWorktreesForProjects(
  projects: readonly string[],
  herdr: Herdr,
  gitRunner: CommandRunner = runGitCommand,
  signal?: AbortSignal,
): Promise<WorktreeRecord[]> {
  signal?.throwIfAborted();
  const results: WorktreeRecord[] = [];
  const seen = new Set<string>();
  const perProject = await Promise.all(
    projects.map((project) => listWorktreesForProject(project, herdr, gitRunner, signal)),
  );

  for (const worktree of perProject.flat()) {
    if (seen.has(worktree.path)) continue;
    seen.add(worktree.path);
    results.push(worktree);
  }

  return results.sort((left, right) => left.path.localeCompare(right.path));
}

export async function listWorktreesForContext(
  context: CurrentContext,
  herdr: Herdr,
  signal?: AbortSignal,
): Promise<WorktreeListResult> {
  signal?.throwIfAborted();
  const lookup = context.workspaceId ? ["--workspace", context.workspaceId] : context.cwd ? ["--cwd", context.cwd] : [];
  if (lookup.length === 0) throw new Error("Cannot open repository worktrees without a source workspace or cwd.");
  const result = readWorktrees(await herdr.json(["worktree", "list", ...lookup, "--json"]));
  signal?.throwIfAborted();
  if (!result.sourceRepoRoot) throw new Error("Herdr worktree list response did not include source.repo_root.");
  return {
    ...result,
    worktrees: result.worktrees.map((worktree) => ({
      ...worktree,
      repoRoot: worktree.repoRoot ?? result.sourceRepoRoot,
    })),
  };
}

export async function listWorktreesForProject(
  project: string,
  herdr: Herdr,
  gitRunner: CommandRunner = runGitCommand,
  signal?: AbortSignal,
): Promise<WorktreeRecord[]> {
  signal?.throwIfAborted();
  try {
    const result = readWorktrees(await herdr.json(["worktree", "list", "--cwd", project, "--json"]));
    signal?.throwIfAborted();
    return result.worktrees.map((worktree) => ({
      ...worktree,
      repoRoot: worktree.repoRoot ?? result.sourceRepoRoot,
    }));
  } catch (error) {
    signal?.throwIfAborted();
    if (!(error instanceof HerdrCommandError)) throw error;
    return listGitWorktrees(project, gitRunner, signal);
  }
}

export async function listGitWorktrees(
  project: string,
  runner: CommandRunner,
  signal?: AbortSignal,
): Promise<WorktreeRecord[]> {
  signal?.throwIfAborted();
  let result;
  try {
    result = await runner([GIT_COMMAND, "-C", project, "worktree", "list", "--porcelain"], signal);
  } catch (error) {
    signal?.throwIfAborted();
    throw error;
  }
  signal?.throwIfAborted();
  if (result.exitCode !== 0) return [];

  const records: WorktreeRecord[] = [];
  for (const block of result.stdout.split("\n\n")) {
    const record = parsePorcelainBlock(block, project);
    if (record) records.push(record);
  }
  return records;
}

async function runGitCommand(argv: readonly string[], signal?: AbortSignal) {
  signal?.throwIfAborted();
  const proc = Bun.spawn([...argv], {
    stdout: "pipe",
    stderr: "pipe",
    ...(signal === undefined ? {} : { signal }),
  });
  let result: [string, string, number];
  try {
    result = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
  } catch (error) {
    signal?.throwIfAborted();
    throw error;
  }
  signal?.throwIfAborted();
  const [stdout, stderr, exitCode] = result;
  return { stdout, stderr, exitCode };
}

function parsePorcelainBlock(block: string, project: string): WorktreeRecord | undefined {
  const fields = new Map<string, string>();
  let bare = false;
  let detached = false;

  for (const line of block.split("\n")) {
    if (line === "bare") bare = true;
    if (line === "detached") detached = true;
    const [key, ...rest] = line.split(" ");
    if (key && rest.length > 0) fields.set(key, rest.join(" "));
  }

  const path = fields.get("worktree");
  if (!path) return undefined;
  return {
    path,
    branch: fields.get("branch")?.replace(/^refs\/heads\//, ""),
    repoRoot: project,
    isBare: bare,
    isDetached: detached,
    isLinkedWorktree: path !== project,
    isPrunable: fields.has("prunable"),
  };
}
