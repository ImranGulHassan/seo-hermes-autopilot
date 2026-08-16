import test from "node:test";
import assert from "node:assert/strict";
import { PostgresChangeLedger, PostgresWebhookDeliveryStore, type Queryable } from "../src/index.js";
import type { ChangeRecord } from "@seo-autopilot/core";

test("change ledger persists provider identifiers and serialized immutable baseline", async () => {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  const database: Queryable = { query: async (sql, values) => { calls.push({ sql, ...(values ? { values } : {}) }); return { rows: [], rowCount: 1, command: "", oid: 0, fields: [] }; } };
  const ledger = new PostgresChangeLedger(database);
  const record: ChangeRecord = {
    id: "chg_1", opportunityId: "opp_1", fingerprint: "fingerprint", affectedUrls: ["https://example.com/"], state: "proposed", approvalRequired: true,
    externalPullRequest: { provider: "github", owner: "acme", repository: "site", number: 7, nodeId: "PR_node", headBranch: "seo-autopilot/opp_1" },
    baseline: { startDate: "2026-01-01", endDate: "2026-01-28", impressions: 1000, clicks: 50, ctr: 0.05, position: 5, conversions: 2, conversionValue: 200, indexed: true },
    createdAt: "2026-02-01T00:00:00Z", evaluations: []
  };
  await ledger.save(record);
  assert.equal(calls[0]?.values?.[4], "acme");
  assert.equal(JSON.parse(String(calls[0]?.values?.[8])).baseline.impressions, 1000);
});

test("webhook delivery writes are conflict-safe", async () => {
  let sql = "";
  const database: Queryable = { query: async (text) => { sql = text; return { rows: [], rowCount: 1, command: "", oid: 0, fields: [] }; } };
  await new PostgresWebhookDeliveryStore(database).add("delivery");
  assert.match(sql, /ON CONFLICT DO NOTHING/);
});
