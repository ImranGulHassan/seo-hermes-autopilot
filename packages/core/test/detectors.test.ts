import test from "node:test";
import assert from "node:assert/strict";
import { analyzeDetectors, runDetectors } from "../src/index.js";
import { metrics, pages } from "./fixtures.js";

test("runs the five focused detectors and returns evidence-backed opportunities", () => {
  const opportunities = runDetectors({ pages, metrics, sitemapUrls: pages.map((page) => page.url) });
  const types = new Set(opportunities.map((item) => item.type));
  assert.deepEqual(types, new Set(["broken-link", "metadata", "under-linked", "ctr-anomaly", "indexability-conflict"]));
  for (const opportunity of opportunities) {
    assert.ok(opportunity.fingerprint);
    assert.ok(opportunity.affectedUrls.length > 0);
    assert.ok(Object.keys(opportunity.evidence).length > 0);
    assert.ok(opportunity.validation.length > 0);
  }
});

test("does not produce a CTR anomaly without enough comparable peers", () => {
  const opportunities = runDetectors({ pages, metrics: metrics.slice(0, 3) });
  assert.equal(opportunities.some((item) => item.type === "ctr-anomaly"), false);
});

test("reports repository routes that are live but absent from the sitemap", () => {
  const page = {
    ...pages[0]!,
    url: "https://example.com/repository-only",
    canonical: "https://example.com/repository-only",
    sitemapListed: false,
    sourcePath: "src/app/repository-only/page.tsx",
    internalLinks: []
  };
  const opportunity = runDetectors({ pages: [page], metrics: [], sitemapUrls: [] }).find((item) => item.type === "indexability-conflict");
  assert.equal(opportunity?.confidence, "medium");
  assert.deepEqual(opportunity?.evidence.issues, ["indexable repository route is absent from sitemap"]);
});

test("matches GSC metrics across trailing-slash and www canonical aliases", () => {
  const page = {
    ...pages[0]!,
    url: "https://www.example.com/guide/",
    title: "A sufficiently descriptive guide title",
    description: "A sufficiently descriptive guide summary that is useful to search visitors.",
    internalLinks: []
  };
  const opportunities = runDetectors({
    pages: [page],
    metrics: [{ url: "https://example.com/guide", impressions: 250, clicks: 10, ctr: 0.04, position: 8, conversions: 0, conversionValue: 0 }],
    sitemapUrls: ["https://example.com/guide"]
  });
  const underLinked = opportunities.find((item) => item.type === "under-linked");
  assert.equal(underLinked?.evidence.impressions28d, 250);
});

test("reports detector-level no-issue evidence instead of an unexplained zero", () => {
  const analysis = analyzeDetectors({ pages: [], metrics: [] });
  assert.equal(analysis.opportunities.length, 0);
  assert.equal(analysis.diagnostics.length, 5);
  assert.ok(analysis.diagnostics.every((item) => item.status === "no-issues" && item.note.length > 0));
});
