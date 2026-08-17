import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { workspaceConfigSchema, type ScanArtifact } from "@seo-autopilot/core";
import { orchestrate } from "../src/index.js";

const run = promisify(execFile);

test("prepares reviewed static metadata without modifying the repository", async (context) => {
  const root = await repositoryFixture("app/about/page.tsx");
  context.after(() => rm(root, { recursive: true, force: true }));
  const sourcePath = resolve(root, "app/about/page.tsx");
  const before = await readFile(sourcePath, "utf8");

  const result = await orchestrate(config(root, [], "/about"), artifact("https://example.com/about"), false);

  assert.deepEqual(result.items.map((item) => item.status), ["ready"]);
  assert.equal(result.items[0]?.file, "app/about/page.tsx");
  assert.equal(await readFile(sourcePath, "utf8"), before);
});

test("keeps protected and dynamic metadata routes proposal-only", async (context) => {
  const protectedRoot = await repositoryFixture("app/about/page.tsx");
  const dynamicRoot = await repositoryFixture("app/posts/[slug]/page.tsx");
  context.after(() => Promise.all([rm(protectedRoot, { recursive: true, force: true }), rm(dynamicRoot, { recursive: true, force: true })]));

  const protectedResult = await orchestrate(config(protectedRoot, ["about/**"], "/about"), artifact("https://example.com/about"), false);
  const dynamicResult = await orchestrate(config(dynamicRoot, [], "/posts/example"), artifact("https://example.com/posts/example"), false);

  assert.match(protectedResult.items[0]?.reason ?? "", /not a supported, unprotected static source page/);
  assert.match(dynamicResult.items[0]?.reason ?? "", /not a supported, unprotected static source page/);
});

function config(rootDir: string, protectedPaths: string[], url: string) {
  return workspaceConfigSchema.parse({
    version: 1,
    siteUrl: "https://example.com",
    protectedPaths,
    repository: { rootDir, contentRoots: [], validators: [] },
    orchestration: {
      maxChanges: 5,
      metadataRepairs: [{
        url,
        description: "Learn about the Example team, its product principles, and the information published on this page.",
        approvedBy: "owner@example.com",
        approvedAt: "2026-08-16T09:00:00.000Z",
        note: "Reviewed against visible page copy"
      }]
    }
  });
}

function artifact(url: string): ScanArtifact {
  return {
    schemaVersion: 1,
    runId: "run_metadata_orchestration",
    startedAt: "2026-08-16T00:00:00.000Z",
    completedAt: "2026-08-16T00:01:00.000Z",
    siteUrl: "https://example.com",
    dataState: "technical-only",
    pages: [{ url, status: 200, title: "About the Example Team", description: null, canonical: null, robots: [], sitemapListed: true, indexable: true, internalLinks: [], sourcePath: null }],
    metrics: [],
    errors: [],
    opportunities: [{
      id: "opp_metadata_orchestration",
      fingerprint: "metadata-orchestration",
      type: "metadata",
      title: "Repair page metadata",
      affectedUrls: [url],
      evidence: { issues: ["missing or defective description"], title: "About the Example Team", description: null },
      confidence: "high",
      estimatedValue: 1,
      proposedFix: "Write unique metadata grounded in visible page content.",
      validation: ["Build succeeds"],
      approvalPolicy: "eligible-after-trust-ramp"
    }]
  };
}

async function repositoryFixture(pagePath: string): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "seo-metadata-orchestration-"));
  await mkdir(resolve(root, pagePath, ".."), { recursive: true });
  await writeFile(resolve(root, pagePath), `export const metadata = {\n  title: "About the Example Team",\n};\nexport default function Page() { return <main>About</main>; }\n`);
  await run("git", ["init"], { cwd: root });
  await run("git", ["add", pagePath], { cwd: root });
  await run("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "fixture"], { cwd: root });
  return root;
}
