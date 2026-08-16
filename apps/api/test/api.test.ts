import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { InMemoryChangeLedger } from "@seo-autopilot/core";
import { InMemoryWebhookDeliveryStore } from "@seo-autopilot/connectors";
import { createApp } from "../src/app.js";

test("health is public while product reads require API authentication", async () => {
  const app = createApp({ stores: { changes: new InMemoryChangeLedger(), deliveries: new InMemoryWebhookDeliveryStore(), listOpportunities: async () => [], listRecentRuns: async () => [], saveRun: async () => {} }, apiSecret: "api-secret", githubWebhookSecret: "hook-secret" });
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
  const app = createApp({ stores: { changes: new InMemoryChangeLedger(), deliveries: new InMemoryWebhookDeliveryStore(), listOpportunities: async () => [], listRecentRuns: async () => [], saveRun: async () => {} }, apiSecret: "api-secret", githubWebhookSecret: "hook-secret" });
  const body = JSON.stringify({ zen: "safe" });
  assert.equal((await app.request("/webhooks/github", { method: "POST", body, headers: { "x-github-event": "ping", "x-github-delivery": "one", "x-hub-signature-256": "sha256=bad" } })).status, 401);
  const signature = `sha256=${createHmac("sha256", "hook-secret").update(body).digest("hex")}`;
  assert.equal((await app.request("/webhooks/github", { method: "POST", body, headers: { "x-github-event": "ping", "x-github-delivery": "two", "x-hub-signature-256": signature } })).status, 200);
});
