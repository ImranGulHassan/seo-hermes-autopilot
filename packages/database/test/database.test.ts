import test from "node:test";
import assert from "node:assert/strict";
import { migrate, PostgresChangeLedger, PostgresRunStore, PostgresTenantStore, PostgresWebhookDeliveryStore, type Queryable } from "../src/index.js";
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
  await store.listRecent("org_one", 30, "site_two");
  await store.listChanges("org_one", "site_two");
  assert.match(calls[0]!.sql, /s\.organization_id=\$1 AND r\.site_id=\$2/);
  assert.deepEqual(calls[0]!.values, ["org_one", "site_two", 30]);
  assert.match(calls[1]!.sql, /s\.organization_id=\$1 AND c\.site_id=\$2/);
  assert.deepEqual(calls[1]!.values, ["org_one", "site_two"]);
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
  assert.match(sql, /CREATE TABLE IF NOT EXISTS users/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS organizations/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS memberships/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS auth_sessions/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS login_tokens/);
  assert.match(sql, /ALTER TABLE sites ADD COLUMN IF NOT EXISTS organization_id/);
});

test("tenant site reads always include the organization boundary", async () => {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  const database: Queryable = { query: async (sql, values) => {
    calls.push({ sql, ...(values ? { values } : {}) });
    return { rows: [], rowCount: 0, command: "", oid: 0, fields: [] };
  } };
  const tenants = new PostgresTenantStore(database);
  assert.equal(await tenants.getSite("org_a", "site_shared"), undefined);
  assert.deepEqual(await tenants.listSites("org_a"), []);
  assert.match(calls[0]!.sql, /id=\$1 AND organization_id=\$2/);
  assert.deepEqual(calls[0]!.values, ["site_shared", "org_a"]);
  assert.match(calls[1]!.sql, /WHERE organization_id=\$1/);
  assert.deepEqual(calls[1]!.values, ["org_a"]);
});

test("membership lookup cannot cross organizations", async () => {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  const database: Queryable = { query: async (sql, values) => {
    calls.push({ sql, ...(values ? { values } : {}) });
    return { rows: [], rowCount: 0, command: "", oid: 0, fields: [] };
  } };
  const membership = await new PostgresTenantStore(database).getMembership("user_1", "org_b");
  assert.equal(membership, undefined);
  assert.match(calls[0]!.sql, /user_id=\$1 AND organization_id=\$2/);
  assert.deepEqual(calls[0]!.values, ["user_1", "org_b"]);
});

test("site creation refuses an existing site owned by another organization", async () => {
  const database: Queryable = { query: async () => ({
    rows: [{ id: "site_1", organization_id: "org_existing", url: "https://example.com", created_at: "2026-01-01T00:00:00Z" }],
    rowCount: 1, command: "", oid: 0, fields: []
  }) };
  await assert.rejects(
    new PostgresTenantStore(database).createSite({ id: "site_1", organizationId: "org_other", url: "https://example.com" }),
    /another organization/
  );
});

test("active sessions exclude expired and revoked records in SQL", async () => {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  const database: Queryable = { query: async (sql, values) => {
    calls.push({ sql, ...(values ? { values } : {}) });
    return { rows: [], rowCount: 0, command: "", oid: 0, fields: [] };
  } };
  const at = new Date("2026-08-24T00:00:00Z");
  assert.equal(await new PostgresTenantStore(database).findActiveSession("sha256", at), undefined);
  assert.match(calls[0]!.sql, /revoked_at IS NULL AND expires_at>\$2/);
  assert.deepEqual(calls[0]!.values, ["sha256", at.toISOString()]);
});

test("organization creation grants the requested user owner membership", async () => {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  const database: Queryable = { query: async (sql, values) => {
    calls.push({ sql, ...(values ? { values } : {}) });
    return { rows: sql.includes("RETURNING id,slug") ? [{ id: "org_1", slug: "acme", name: "Acme", created_at: "2026-01-01T00:00:00Z" }] : [], rowCount: 1, command: "", oid: 0, fields: [] };
  } };
  const organization = await new PostgresTenantStore(database).createOrganization({ id: "org_1", slug: "acme", name: "Acme", ownerUserId: "user_1" });
  assert.equal(organization.id, "org_1");
  assert.match(calls[1]!.sql, /INSERT INTO memberships/);
  assert.deepEqual(calls[1]!.values, ["org_1", "user_1", "owner"]);
});
