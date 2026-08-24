import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { InMemoryChangeLedger } from "@seo-autopilot/core";
import { InMemoryWebhookDeliveryStore } from "@seo-autopilot/connectors";
import { createApp } from "../src/app.js";

test("health is public while product reads require API authentication", async () => {
  const app = createApp({ stores: { changes: new InMemoryChangeLedger(), deliveries: new InMemoryWebhookDeliveryStore(), listSites: async () => [], listChanges: async () => [], listOpportunities: async () => [], listRecentRuns: async () => [], saveRun: async () => {} }, apiSecret: "api-secret", githubWebhookSecret: "hook-secret" });
  assert.equal((await app.request("/health")).status, 200);
  assert.equal((await app.request("/v1/changes")).status, 401);
  assert.equal((await app.request("/v1/changes", { headers: { authorization: "Bearer api-secret" } })).status, 400);
  const response = await app.request("/v1/changes", { headers: { authorization: "Bearer api-secret", "x-organization-id": "org_one" } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { changes: [] });
  const scorecard = await app.request("/v1/pilot-scorecard", { headers: { authorization: "Bearer api-secret", "x-organization-id": "org_one" } });
  assert.equal(scorecard.status, 200);
  assert.deepEqual((await scorecard.json()).scorecard.gates, { acceptance: "insufficient-data", rollback: "insufficient-data", paidConversion: "unavailable" });
});

test("GitHub endpoint requires a valid raw-body signature", async () => {
  const app = createApp({ stores: { changes: new InMemoryChangeLedger(), deliveries: new InMemoryWebhookDeliveryStore(), listSites: async () => [], listChanges: async () => [], listOpportunities: async () => [], listRecentRuns: async () => [], saveRun: async () => {} }, apiSecret: "api-secret", githubWebhookSecret: "hook-secret" });
  const body = JSON.stringify({ zen: "safe" });
  assert.equal((await app.request("/webhooks/github", { method: "POST", body, headers: { "x-github-event": "ping", "x-github-delivery": "one", "x-hub-signature-256": "sha256=bad" } })).status, 401);
  const signature = `sha256=${createHmac("sha256", "hook-secret").update(body).digest("hex")}`;
  assert.equal((await app.request("/webhooks/github", { method: "POST", body, headers: { "x-github-event": "ping", "x-github-delivery": "two", "x-hub-signature-256": signature } })).status, 200);
});

test("dashboard scopes runs and changes to an organization and validated site", async () => {
  const calls: Array<{ kind: string; organizationId: string; siteId?: string }> = [];
  const stores = {
    changes: new InMemoryChangeLedger(), deliveries: new InMemoryWebhookDeliveryStore(),
    listSites: async () => [{ id: "site_one", url: "https://one.example", lastRunAt: null }, { id: "site_two", url: "https://two.example", lastRunAt: null }],
    listChanges: async (organizationId: string, siteId?: string) => { calls.push({ kind: "changes", organizationId, ...(siteId ? { siteId } : {}) }); return []; },
    listOpportunities: async () => [],
    listRecentRuns: async (organizationId: string, _limit?: number, siteId?: string) => { calls.push({ kind: "runs", organizationId, ...(siteId ? { siteId } : {}) }); return []; },
    saveRun: async () => {}
  };
  const app = createApp({ stores, apiSecret: "api-secret", githubWebhookSecret: "hook-secret" });
  const headers = { authorization: "Bearer api-secret", "x-organization-id": "org_one" };
  assert.equal((await app.request("/v1/dashboard?siteId=site_two", { headers })).status, 200);
  assert.deepEqual(calls, [{ kind: "runs", organizationId: "org_one", siteId: "site_two" }, { kind: "changes", organizationId: "org_one", siteId: "site_two" }]);
  assert.equal((await app.request("/v1/dashboard?siteId=unknown", { headers })).status, 404);
});

test("dashboard reports real GSC movement, low CTR, freshness and connector state", async () => {
  const artifact = (runId: string, window: { startDate: string; endDate: string }, clicks: number, completedAt: string) => ({
    schemaVersion: 1 as const, runId, startedAt: completedAt, completedAt, siteUrl: "https://one.example", dataState: "search-performance" as const, analyticsState: "not-configured" as const, metricWindow: window,
    pages: [], errors: [], opportunities: [], queryMetrics: [{ query: "real query", impressions: 100, clicks, ctr: clicks / 100, position: 5 }],
    metrics: [
      { url: "https://one.example/winner", impressions: 100, clicks, ctr: clicks / 100, position: 5, conversions: 0, conversionValue: 0 },
      { url: "https://one.example/low", impressions: 100, clicks: 0, ctr: 0, position: 8, conversions: 0, conversionValue: 0 }
    ]
  });
  const runs = [artifact("run_new", { startDate: "2026-07-29", endDate: "2026-08-24" }, 20, new Date().toISOString()), artifact("run_old", { startDate: "2026-07-02", endDate: "2026-07-28" }, 10, "2026-07-29T00:00:00.000Z")];
  const app = createApp({ stores: { changes: new InMemoryChangeLedger(), deliveries: new InMemoryWebhookDeliveryStore(), listSites: async () => [{ id: "site_one", url: "https://one.example", lastRunAt: null }], listChanges: async () => [], listOpportunities: async () => [], listRecentRuns: async () => runs, saveRun: async () => {} }, apiSecret: "api-secret", githubWebhookSecret: "hook-secret" });
  const response = await app.request("/v1/dashboard", { headers: { authorization: "Bearer api-secret", "x-organization-id": "org_one" } });
  const body = await response.json() as any;
  assert.equal(body.performance.comparison.available, true);
  assert.equal(body.performance.winningPages[0].clickDelta, 10);
  assert.equal(body.performance.lowCtrPages[0].url, "https://one.example/low");
  assert.equal(body.connectors.searchConsole.state, "healthy");
  assert.equal(body.connectors.conversions.state, "not-configured");
  assert.equal(body.freshness.state, "fresh");
});

test("pilot readiness requires five partners and three active converted users", async () => {
  const partners = Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, status: "active", convertedAt: index < 3 ? "2026-08-24T00:00:00.000Z" : null, conversionIntent: index < 3 ? "yes" : "unknown", weeklyFeedback: [{ activeUse: index < 3 }] }));
  const app = createApp({ stores: { changes: new InMemoryChangeLedger(), deliveries: new InMemoryWebhookDeliveryStore(), listSites: async () => [], listChanges: async () => [], listOpportunities: async () => [], listRecentRuns: async () => [], saveRun: async () => {}, listDesignPartners: async () => partners }, apiSecret: "api-secret", githubWebhookSecret: "hook-secret" });
  const response = await app.request("/v1/pilot-readiness", { headers: { authorization: "Bearer api-secret", "x-organization-id": "org_one" } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).gates.launchReady, true);
});
