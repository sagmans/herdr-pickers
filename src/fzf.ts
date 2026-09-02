export const FZF_MIN_VERSION = "0.48";

import type { PickerItem } from "./picker-row.ts";

const FIELD_DELIMITER = "\t";
const FZF_COMMAND = "fzf";
const FZF_SUCCESS = 0;
const FZF_NO_MATCH = 1;
const MIN_SOURCE_INDEX = 0;
const FZF_FILTER_ARGS = [
  "--delimiter",
  FIELD_DELIMITER,
  "--with-nth",
  "1",
  "--nth",
  "1",
] as const;

export async function rankRows(query: string, items: readonly PickerItem[]): Promise<PickerItem[]> {
  if (query.length === 0) return [...items];
  if (items.length === 0) return [];
  const indexedLines = items.map((item, index) => `${item.searchText}${FIELD_DELIMITER}${index}`);

  const proc = Bun.spawn([FZF_COMMAND, ...FZF_FILTER_ARGS, "--filter", query], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(`${indexedLines.join("\n")}\n`);
  await proc.stdin.flush();
  proc.stdin.end();

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode === FZF_NO_MATCH) return [];
  if (exitCode !== FZF_SUCCESS) {
    throw new Error(`fzf filter failed with exit code ${exitCode}`);
  }
  return stdout.split("\n").filter((line) => line.length > 0).map((line) => {
    const sourceIndex = Number(line.slice(line.lastIndexOf(FIELD_DELIMITER) + FIELD_DELIMITER.length));
    const source = Number.isSafeInteger(sourceIndex) && sourceIndex >= MIN_SOURCE_INDEX ? items[sourceIndex] : undefined;
    if (source === undefined) throw new Error(`fzf returned invalid source index: ${sourceIndex}`);
    return source;
  });
}
