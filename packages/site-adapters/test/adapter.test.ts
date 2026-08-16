import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { discoverSourcePages, inspectGitFileStates, planMetadataPatch, planRedirectLinkPatch, planRepositoryLinkPatches, validateAndApply, validatePatchPlan, validatePatchSet } from "../src/index.js";

const run = promisify(execFile);

async function fixture(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "seo-adapter-test-"));
  await mkdir(resolve(root, "src/app/(marketing)/about"), { recursive: true });
  await mkdir(resolve(root, "src/app/dynamic/[slug]"), { recursive: true });
  await mkdir(resolve(root, "content/guides"), { recursive: true });
  await writeFile(resolve(root, "src/app/page.tsx"), `export const metadata = {\n  title: "Existing home page title",\n  description: "An existing home page description that is sufficiently descriptive for users.",\n};\nexport default function Page() { return <a href="/old">Old</a>; }\n`);
  await writeFile(resolve(root, "src/app/(marketing)/about/page.tsx"), "export default function Page() { return <main>About</main>; }\n");
  await writeFile(resolve(root, "src/app/dynamic/[slug]/page.tsx"), "export default function Page() { return null; }\n");
  await writeFile(resolve(root, "content/guides/resume.mdx"), `---\ntitle: "Resume Guide"\ndescription: "An existing guide description with enough detail to be considered useful."\nslug: guides/resume\n---\n\n[Old destination](/old)\n`);
  return root;
}

test("discovers static App Router and MDX routes but skips unsupported dynamic routes", async (context) => {
  const root = await fixture();
  context.after(() => rm(root, { recursive: true, force: true }));
  const pages = await discoverSourcePages({ rootDir: root, baseUrl: "https://example.com" });
  assert.deepEqual(pages.map((page) => [page.route, page.kind]), [["/guides/resume", "mdx"], ["/about", "next-app-router"], ["/", "next-app-router"]]);
  assert.equal(pages.some((page) => page.route.includes("slug")), false);
});

test("discovers a monorepo Next.js app while retaining repository-relative paths", async (context) => {
  const root = await mkdtemp(resolve(tmpdir(), "seo-adapter-monorepo-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(resolve(root, "apps/web/app/about"), { recursive: true });
  await writeFile(resolve(root, "apps/web/app/about/page.tsx"), "export default function Page() { return <main>About</main>; }\n");
  const pages = await discoverSourcePages({ rootDir: root, frameworkRoot: "apps/web", baseUrl: "https://example.com", contentRoots: [] });
  assert.equal(pages[0]?.route, "/about");
  assert.equal(pages[0]?.filePath, "apps/web/app/about/page.tsx");
  await assert.rejects(() => discoverSourcePages({ rootDir: root, frameworkRoot: "../outside", baseUrl: "https://example.com" }), /inside the repository/);
});

test("excludes protected routes from repository discovery", async (context) => {
  const root = await fixture();
  context.after(() => rm(root, { recursive: true, force: true }));
  const pages = await discoverSourcePages({ rootDir: root, baseUrl: "https://example.com", protectedPaths: ["about/**"] });
  assert.equal(pages.some((page) => page.route === "/about"), false);
});

test("prefers an explicit MDX canonical route over a bare slug", async (context) => {
  const root = await fixture();
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(resolve(root, "content/guides/resume.mdx"), `---\ntitle: "Resume Guide"\ndescription: "An existing guide description with enough detail to be considered useful."\nslug: resume\ncanonical: /guides/resume\n---\n`);
  const page = (await discoverSourcePages({ rootDir: root, baseUrl: "https://example.com" })).find((item) => item.kind === "mdx");
  assert.equal(page?.route, "/guides/resume");
});

test("plans stable metadata and redirect-link patches without touching the repository", async (context) => {
  const root = await fixture();
  context.after(() => rm(root, { recursive: true, force: true }));
  const pages = await discoverSourcePages({ rootDir: root, baseUrl: "https://example.com" });
  const mdx = pages.find((page) => page.kind === "mdx")!;
  const before = await readFile(resolve(root, mdx.filePath), "utf8");
  const metadataPatch = await planMetadataPatch(root, mdx, { title: "A Better and More Specific Resume Guide Title" });
  assert.match(metadataPatch?.after ?? "", /title: "A Better and More Specific Resume Guide Title"/);
  assert.equal(await readFile(resolve(root, mdx.filePath), "utf8"), before);
  const redirectPatch = await planRedirectLinkPatch(root, mdx, "https://example.com/old", "https://example.com/new");
  assert.match(redirectPatch?.after ?? "", /\]\(\/new\)/);
});

test("applies only after validators pass", async (context) => {
  const root = await fixture();
  context.after(() => rm(root, { recursive: true, force: true }));
  const home = (await discoverSourcePages({ rootDir: root, baseUrl: "https://example.com" })).find((page) => page.route === "/")!;
  const patch = await planMetadataPatch(root, home, { title: "A Replacement Home Page Title That Is Specific" });
  assert.ok(patch);
  await assert.rejects(() => validateAndApply({ rootDir: root, patches: [patch], validators: [{ name: "fixture-validator", command: process.execPath, args: ["-e", "process.exit(1)"] }] }), /Patch set rejected/);
  assert.equal(await readFile(resolve(root, home.filePath), "utf8"), patch.before);
  const result = await validateAndApply({ rootDir: root, patches: [patch], validators: [{ name: "fixture-validator", command: process.execPath, args: ["-e", "process.exit(0)"] }] });
  assert.deepEqual(result.applied, [home.filePath]);
  assert.equal(result.validations.every((validation) => validation.passed), true);
  assert.equal(await readFile(resolve(root, home.filePath), "utf8"), patch.after);
});

test("validates a patch plan without modifying the repository", async (context) => {
  const root = await fixture();
  context.after(() => rm(root, { recursive: true, force: true }));
  const home = (await discoverSourcePages({ rootDir: root, baseUrl: "https://example.com" })).find((page) => page.route === "/")!;
  const patch = await planRedirectLinkPatch(root, home, "https://example.com/old", "https://example.com/new");
  assert.ok(patch);
  const results = await validatePatchPlan({ rootDir: root, patches: [patch] });
  assert.equal(results.every((result) => result.passed), true);
  assert.equal(await readFile(resolve(root, home.filePath), "utf8"), patch.before);
});

test("traces structured links across repository files without changing canonical metadata", async (context) => {
  const root = await fixture();
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(resolve(root, "content/guides/resume.mdx"), `---\ncanonical: "/old"\nparent: "/old"\nrelatedContent: ["/old", "/keep"]\n---\n\n[Old](/old)\n`);
  const patches = await planRepositoryLinkPatches(root, "https://example.com/old", "https://example.com/new");
  assert.equal(patches.length, 2);
  const mdx = patches.find((patch) => patch.filePath.endsWith("resume.mdx"))!;
  assert.match(mdx.after, /canonical: "\/old"/);
  assert.match(mdx.after, /parent: "\/new"/);
  assert.match(mdx.after, /relatedContent: \["\/new", "\/keep"\]/);
  assert.match(mdx.after, /\[Old\]\(\/new\)/);
});

test("rejects protected and escaping paths before staging", () => {
  const base = { beforeHash: "hash", before: "a", after: "b", reason: "test" };
  assert.throws(() => validatePatchSet([{ ...base, filePath: "src/app/legal/terms/page.tsx" }], ["legal/**"]), /Protected path/);
  assert.throws(() => validatePatchSet([{ ...base, filePath: "../outside.ts" }], []), /escapes/);
});

test("classifies tracked-clean, modified, and untracked repository files", async (context) => {
  const root = await fixture();
  context.after(() => rm(root, { recursive: true, force: true }));
  await run("git", ["init"], { cwd: root });
  await run("git", ["add", "src/app/page.tsx", "content/guides/resume.mdx"], { cwd: root });
  await run("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "fixture"], { cwd: root });
  await writeFile(resolve(root, "content/guides/resume.mdx"), "changed\n");
  const states = await inspectGitFileStates(root, ["src/app/page.tsx", "content/guides/resume.mdx", "src/app/(marketing)/about/page.tsx"]);
  assert.equal(states.get("src/app/page.tsx"), "tracked-clean");
  assert.equal(states.get("content/guides/resume.mdx"), "tracked-modified");
  assert.equal(states.get("src/app/(marketing)/about/page.tsx"), "untracked");
});
