import test from "node:test";
import assert from "node:assert/strict";
import { migrate, PostgresChangeLedger, PostgresRunStore, PostgresWebhookDeliveryStore, type Queryable } from "../src/index.js";
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
  assert.equal(calls[0]?.values?.[5], "acme");
  assert.equal(JSON.parse(String(calls[0]?.values?.[9])).baseline.impressions, 1000);
});

test("site-scoped change ledger cannot list another site's records", async () => {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  const database: Queryable = { query: async (sql, values) => { calls.push({ sql, ...(values ? { values } : {}) }); return { rows: [], rowCount: 0, command: "", oid: 0, fields: [] }; } };
  await new PostgresChangeLedger(database, "site_one").list();
  assert.match(calls[0]!.sql, /WHERE c\.site_id=\$1/);
  assert.deepEqual(calls[0]!.values, ["site_one"]);
});

test("run and change reads are scoped by site when requested", async () => {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  const database: Queryable = { query: async (sql, values) => { calls.push({ sql, ...(values ? { values } : {}) }); return { rows: [], rowCount: 0, command: "", oid: 0, fields: [] }; } };
  const store = new PostgresRunStore(database);
  await store.listRecent(30, "site_two");
  await store.listChanges("site_two");
  assert.match(calls[0]!.sql, /WHERE site_id=\$1/);
  assert.deepEqual(calls[0]!.values, ["site_two", 30]);
  assert.match(calls[1]!.sql, /WHERE c\.site_id=\$1/);
  assert.deepEqual(calls[1]!.values, ["site_two"]);
});

test("webhook delivery writes are conflict-safe", async () => {
  let sql = "";
  const database: Queryable = { query: async (text) => { sql = text; return { rows: [], rowCount: 1, command: "", oid: 0, fields: [] }; } };
  await new PostgresWebhookDeliveryStore(database).add("delivery");
  assert.match(sql, /ON CONFLICT DO NOTHING/);
});

test("migration permits analytics-enriched scan artifacts", async () => {
  let sql = "";
  const database: Queryable = { query: async (text) => { sql = text; return { rows: [], rowCount: 0, command: "", oid: 0, fields: [] }; } };
  await migrate(database);
  assert.match(sql, /'analytics-enriched'/);
  assert.match(sql, /DROP CONSTRAINT IF EXISTS runs_data_state_check/);
  assert.match(sql, /ALTER TABLE changes ADD COLUMN IF NOT EXISTS site_id/);
  assert.match(sql, /UPDATE changes c SET site_id = o\.site_id/);
});
