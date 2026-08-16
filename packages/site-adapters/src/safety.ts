import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, relative, resolve, sep } from "node:path";
import type { FilePatch, PatchValidationResult, ValidationCommand } from "./types.js";

export interface ApplyOptions {
  rootDir: string;
  patches: FilePatch[];
  protectedPaths?: string[];
  validators?: ValidationCommand[];
}

export interface ApplyResult {
  applied: string[];
  validations: PatchValidationResult[];
}

export async function validatePatchPlan(options: ApplyOptions): Promise<PatchValidationResult[]> {
  const root = resolve(options.rootDir);
  const protectedPaths = options.protectedPaths ?? ["legal/**", "pricing", "checkout/**", "auth/**"];
  validatePatchSet(options.patches, protectedPaths);
  await verifyOriginals(root, options.patches);
  const stagingParent = await mkdtemp(resolve(tmpdir(), "seo-autopilot-repo-"));
  const stagingRoot = resolve(stagingParent, "repo");
  try {
    await cp(root, stagingRoot, {
      recursive: true,
      filter: (source) => ![".git", ".next", "node_modules", "dist", "coverage", ".seo-autopilot"].includes(relative(root, source).split(sep)[0] ?? "")
    });
    await writePatches(stagingRoot, options.patches);
    const validations: PatchValidationResult[] = [validateContent(options.patches)];
    for (const validator of options.validators ?? []) validations.push(await runCommand(stagingRoot, validator));
    return validations;
  } finally {
    await rm(stagingParent, { recursive: true, force: true });
  }
}

export async function validateAndApply(options: ApplyOptions): Promise<ApplyResult> {
  const root = resolve(options.rootDir);
  const validations = await validatePatchPlan(options);
  const failed = validations.filter((result) => !result.passed);
  if (failed.length > 0) throw new Error(`Patch set rejected: ${failed.map((result) => `${result.name}: ${result.details}`).join("; ")}`);
  await verifyOriginals(root, options.patches);
  await commitPatches(root, options.patches);
  return { applied: options.patches.map((patch) => patch.filePath), validations };
}

export function validatePatchSet(patches: FilePatch[], protectedPaths: string[]): void {
  if (patches.length === 0) throw new Error("No patches were supplied.");
  const seen = new Set<string>();
  for (const patch of patches) {
    const normalized = patch.filePath.replace(/\\/g, "/").replace(/^\.\//, "");
    if (normalized.startsWith("../") || normalized.startsWith("/")) throw new Error(`Patch path escapes the repository: ${patch.filePath}`);
    if (seen.has(normalized)) throw new Error(`Multiple patches target ${normalized}; combine them before validation.`);
    seen.add(normalized);
    if (protectedPaths.some((pattern) => matchesPath(normalized, pattern))) throw new Error(`Protected path cannot be changed: ${normalized}`);
  }
}

function matchesPath(path: string, pattern: string): boolean {
  const clean = pattern.replace(/^\//, "");
  if (clean.endsWith("/**")) {
    const base = clean.slice(0, -3).replace(/\/$/, "");
    return path === base || path.startsWith(`${base}/`) || path.includes(`/${base}/`);
  }
  if (clean.endsWith("/*")) {
    const base = clean.slice(0, -2).replace(/\/$/, "");
    return path.startsWith(`${base}/`) || path.includes(`/${base}/`);
  }
  return path === clean || path.includes(`/${clean}`);
}

async function verifyOriginals(root: string, patches: FilePatch[]): Promise<void> {
  for (const patch of patches) {
    const current = await readFile(resolve(root, patch.filePath), "utf8");
    const hash = createHash("sha256").update(current).digest("hex");
    if (hash !== patch.beforeHash || current !== patch.before) throw new Error(`${patch.filePath} changed after the patch was planned; refusing to overwrite it.`);
  }
}

function validateContent(patches: FilePatch[]): PatchValidationResult {
  const unchanged = patches.find((patch) => patch.before === patch.after);
  const conflictMarker = patches.find((patch) => /^(?:<{7}|={7}|>{7})/m.test(patch.after));
  if (unchanged) return { name: "patch-content", passed: false, details: `${unchanged.filePath} has no effective change` };
  if (conflictMarker) return { name: "patch-content", passed: false, details: `${conflictMarker.filePath} contains a conflict marker` };
  return { name: "patch-content", passed: true, details: `${patches.length} deterministic patch(es)` };
}

async function writePatches(root: string, patches: FilePatch[]): Promise<void> {
  for (const patch of patches) {
    const target = resolve(root, patch.filePath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, patch.after);
  }
}

async function commitPatches(root: string, patches: FilePatch[]): Promise<void> {
  const committed: FilePatch[] = [];
  try {
    for (const patch of patches) {
      const target = resolve(root, patch.filePath);
      const temporary = `${target}.${process.pid}.seo-autopilot.tmp`;
      await writeFile(temporary, patch.after);
      await rename(temporary, target);
      committed.push(patch);
    }
  } catch (error) {
    await Promise.all(committed.map((patch) => writeFile(resolve(root, patch.filePath), patch.before)));
    throw error;
  }
}

async function runCommand(cwd: string, validator: ValidationCommand): Promise<PatchValidationResult> {
  return new Promise((resolveResult) => {
    const child = spawn(validator.command, validator.args ?? [], { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += String(chunk); });
    child.stderr.on("data", (chunk) => { output += String(chunk); });
    child.on("error", (error) => resolveResult({ name: validator.name, passed: false, details: error.message }));
    child.on("close", (code) => resolveResult({ name: validator.name, passed: code === 0, details: output.trim().slice(-2_000) || `exit ${code}` }));
  });
}
