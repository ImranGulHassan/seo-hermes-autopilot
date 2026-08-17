import test from "node:test";
import assert from "node:assert/strict";
import { reviewedMetadataRepairs, workspaceConfigSchema, type ScanArtifact } from "../src/index.js";

const artifact: ScanArtifact = {
  schemaVersion: 1,
  runId: "run_metadata_fixture",
  startedAt: "2026-08-16T00:00:00.000Z",
  completedAt: "2026-08-16T00:01:00.000Z",
  siteUrl: "https://example.com",
  dataState: "technical-only",
  pages: [
    page("https://example.com/about", "About", null),
    page("https://example.com/other", "Existing Other Page", "A unique existing description for another indexable page on this site.")
  ],
  metrics: [],
  errors: [],
  opportunities: [{
    id: "opp_metadata",
    fingerprint: "metadata",
    type: "metadata",
    title: "Repair page metadata",
    affectedUrls: ["https://example.com/about"],
    evidence: { issues: ["missing or defective title", "missing or defective description"] },
    confidence: "high",
    estimatedValue: 1,
    proposedFix: "Repair",
    validation: ["Build succeeds"],
    approvalPolicy: "eligible-after-trust-ramp"
  }]
};

test("accepts a complete same-origin reviewed metadata repair", () => {
  const repairs = reviewedMetadataRepairs(config({
    url: "/about",
    title: "About the Example Company",
    description: "Learn how the Example Company maintains its reviewed product and customer information.",
    approvedBy: "owner@example.com",
    approvedAt: "2026-08-16T09:00:00.000Z"
  }), artifact);
  assert.equal(repairs.get("https://example.com/about")?.approvedBy, "owner@example.com");
});

test("rejects incomplete, stale, off-origin, and duplicate reviewed metadata", () => {
  const approvedAt = "2026-08-16T09:00:00.000Z";
  assert.throws(() => reviewedMetadataRepairs(config({ url: "/about", title: "About the Example Company", approvedBy: "owner@example.com", approvedAt }), artifact), /description/);
  assert.throws(() => reviewedMetadataRepairs(config({ url: "/missing", title: "A Missing Page Title", description: "A sufficiently long description for a page that has no current finding.", approvedBy: "owner@example.com", approvedAt }), artifact), /no current metadata opportunity/);
  assert.throws(() => reviewedMetadataRepairs(config({ url: "https://outside.example/about", title: "An External Page Title", description: "A sufficiently long description that must never cross the configured origin.", approvedBy: "owner@example.com", approvedAt }), artifact), /remain on/);
  assert.throws(() => reviewedMetadataRepairs(config({ url: "/about", title: "Existing Other Page", description: "A unique replacement description that is long enough for validation.", approvedBy: "owner@example.com", approvedAt }), artifact), /duplicates/);
});

function config(repair: Record<string, unknown>) {
  return workspaceConfigSchema.parse({ version: 1, siteUrl: "https://example.com", orchestration: { metadataRepairs: [repair] } });
}

function page(url: string, title: string | null, description: string | null): ScanArtifact["pages"][number] {
  return { url, status: 200, title, description, canonical: null, robots: [], sitemapListed: true, indexable: true, internalLinks: [], sourcePath: null };
}
