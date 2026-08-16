import { execFile } from "node:child_process";
import { promisify } from "node:util";

export type GitFileState = "tracked-clean" | "tracked-modified" | "untracked";

const run = promisify(execFile);

export async function inspectGitFileStates(rootDir: string, filePaths: string[]): Promise<Map<string, GitFileState>> {
  const normalized = filePaths.map((path) => path.replace(/\\/g, "/"));
  const [trackedOutput, unstagedOutput, stagedOutput] = await Promise.all([
    git(rootDir, ["ls-files", "-z"]),
    git(rootDir, ["diff", "--name-only", "-z", "HEAD", "--"]),
    git(rootDir, ["diff", "--cached", "--name-only", "-z", "--"])
  ]);
  const tracked = new Set(splitZero(trackedOutput));
  const modified = new Set([...splitZero(unstagedOutput), ...splitZero(stagedOutput)]);
  return new Map(normalized.map((path) => [path, !tracked.has(path) ? "untracked" : modified.has(path) ? "tracked-modified" : "tracked-clean"]));
}

async function git(cwd: string, args: string[]): Promise<string> {
  try { return (await run("git", args, { cwd, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 })).stdout; }
  catch (error) { throw new Error(`Repository Git state could not be inspected: ${error instanceof Error ? error.message : String(error)}`); }
}

function splitZero(value: string): string[] { return value.split("\0").filter(Boolean).map((path) => path.replace(/\\/g, "/")); }
