import test from "node:test";
import assert from "node:assert/strict";
import { runDetectors } from "../src/index.js";
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
