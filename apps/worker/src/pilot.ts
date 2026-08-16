import { mkdir, open, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { resolveWorkspacePaths } from "./workspaces.js";

const projectRoot = resolve(process.env.INIT_CWD ?? process.cwd());
const stateDirectory = resolve(projectRoot, ".seo-autopilot");
const lockPath = resolve(stateDirectory, "pilot.lock");
const workspaces = resolveWorkspacePaths(process.argv.slice(2), process.env.SEO_AUTOPILOT_WORKSPACES, projectRoot);

await mkdir(stateDirectory, { recursive: true });
await acquireLock(lockPath);
try {
  const startedAt = new Date().toISOString();
  const steps = [
    ...workspaces.flatMap((workspace, index) => [
      { name: `workspace-${index + 1}-scan`, args: ["scan", "workspace", workspace] },
      { name: `workspace-${index + 1}-draft-pr-orchestration`, args: ["scan", "orchestrate", workspace, "--live"] }
    ]),
    { name: "github-reconciliation", args: ["reconcile"] },
    ...workspaces.map((workspace, index) => ({ name: `workspace-${index + 1}-measurement`, args: ["measurement", workspace] }))
  ];
  const completed: string[] = [];
  for (const step of steps) {
    console.log(JSON.stringify({ event: "pilot-step-started", step: step.name, at: new Date().toISOString() }));
    await runPnpm(step.args);
    completed.push(step.name);
    console.log(JSON.stringify({ event: "pilot-step-completed", step: step.name, at: new Date().toISOString() }));
  }
  console.log(JSON.stringify({ event: "pilot-run-completed", startedAt, completedAt: new Date().toISOString(), workspaces, steps: completed }));
} finally {
  await rm(lockPath, { force: true });
}

async function acquireLock(path: string): Promise<void> {
  try {
    const handle = await open(path, "wx", 0o600);
    await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    await handle.close();
  } catch (error) {
    const existing = await readFile(path, "utf8").catch(() => "unknown");
    throw new Error(`Another pilot run holds ${path}: ${existing}`, { cause: error });
  }
}

function runPnpm(args: string[]): Promise<void> {
  return new Promise((resolveRun, reject) => {
    const child = spawn("pnpm", args, { cwd: projectRoot, env: process.env, stdio: "inherit", shell: false });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolveRun();
      else reject(new Error(`pnpm ${args.join(" ")} failed with ${signal ? `signal ${signal}` : `exit code ${code}`}.`));
    });
  });
}
