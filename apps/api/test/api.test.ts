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
  const response = await app.request("/v1/changes", { headers: { authorization: "Bearer api-secret" } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { changes: [] });
  const scorecard = await app.request("/v1/pilot-scorecard", { headers: { authorization: "Bearer api-secret" } });
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

test("dashboard scopes runs and changes to a validated site", async () => {
  const calls: Array<{ kind: string; siteId?: string }> = [];
  const stores = {
    changes: new InMemoryChangeLedger(), deliveries: new InMemoryWebhookDeliveryStore(),
    listSites: async () => [{ id: "site_one", url: "https://one.example", lastRunAt: null }, { id: "site_two", url: "https://two.example", lastRunAt: null }],
    listChanges: async (siteId?: string) => { calls.push({ kind: "changes", ...(siteId ? { siteId } : {}) }); return []; },
    listOpportunities: async () => [],
    listRecentRuns: async (_limit?: number, siteId?: string) => { calls.push({ kind: "runs", ...(siteId ? { siteId } : {}) }); return []; },
    saveRun: async () => {}
  };
  const app = createApp({ stores, apiSecret: "api-secret", githubWebhookSecret: "hook-secret" });
  const headers = { authorization: "Bearer api-secret" };
  assert.equal((await app.request("/v1/dashboard?siteId=site_two", { headers })).status, 200);
  assert.deepEqual(calls, [{ kind: "runs", siteId: "site_two" }, { kind: "changes", siteId: "site_two" }]);
  assert.equal((await app.request("/v1/dashboard?siteId=unknown", { headers })).status, 404);
});
