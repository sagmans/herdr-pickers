import { Herdr, HerdrCommandError, type CommandRunner } from "../client/herdr.ts";
import { readWorktrees, type WorktreeListResult, type WorktreeRecord } from "../client/types.ts";
import type { CurrentContext } from "../catalog.ts";

const GIT_COMMAND = "git";

export async function listWorktreesForProjects(
  projects: readonly string[],
  herdr: Herdr,
  gitRunner: CommandRunner = runGitCommand,
): Promise<WorktreeRecord[]> {
  const results: WorktreeRecord[] = [];
  const seen = new Set<string>();
  const perProject = await Promise.all(projects.map((project) => listWorktreesForProject(project, herdr, gitRunner)));

  for (const worktree of perProject.flat()) {
    if (seen.has(worktree.path)) continue;
    seen.add(worktree.path);
    results.push(worktree);
  }

  return results.sort((left, right) => left.path.localeCompare(right.path));
}

export async function listWorktreesForContext(context: CurrentContext, herdr: Herdr): Promise<WorktreeListResult> {
  const lookup = context.workspaceId ? ["--workspace", context.workspaceId] : context.cwd ? ["--cwd", context.cwd] : [];
  if (lookup.length === 0) throw new Error("Cannot open repository worktrees without a source workspace or cwd.");
  const result = readWorktrees(await herdr.json(["worktree", "list", ...lookup, "--json"]));
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
): Promise<WorktreeRecord[]> {
  try {
    const result = readWorktrees(await herdr.json(["worktree", "list", "--cwd", project, "--json"]));
    return result.worktrees.map((worktree) => ({
      ...worktree,
      repoRoot: worktree.repoRoot ?? result.sourceRepoRoot,
    }));
  } catch (error) {
    if (!(error instanceof HerdrCommandError)) throw error;
    return listGitWorktrees(project, gitRunner);
  }
}

export async function listGitWorktrees(project: string, runner: CommandRunner): Promise<WorktreeRecord[]> {
  const result = await runner([GIT_COMMAND, "-C", project, "worktree", "list", "--porcelain"]);
  if (result.exitCode !== 0) return [];

  const records: WorktreeRecord[] = [];
  for (const block of result.stdout.split("\n\n")) {
    const record = parsePorcelainBlock(block, project);
    if (record) records.push(record);
  }
  return records;
}

async function runGitCommand(argv: readonly string[]) {
  const proc = Bun.spawn([...argv], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
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
