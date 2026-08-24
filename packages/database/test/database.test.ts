import test from "node:test";
import assert from "node:assert/strict";
import { migrate, PostgresChangeLedger, PostgresDesignPartnerStore, PostgresRunStore, PostgresRuntimeJobStore, PostgresTenantStore, PostgresWebhookDeliveryStore, type Queryable } from "../src/index.js";
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
  assert.match(sql, /CREATE TABLE IF NOT EXISTS organization_connectors/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS site_onboarding/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS runtime_jobs/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS design_partners/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS operations_audit/);
  assert.match(sql, /FOREIGN KEY \(site_id, organization_id\) REFERENCES sites\(id, organization_id\)/);
});

test("design-partner reads and feedback remain organization scoped", async () => {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  const database: Queryable = { query: async (sql, values) => { calls.push({ sql, ...(values ? { values } : {}) }); return { rows: [], rowCount: 0, command: "", oid: 0, fields: [] }; } };
  const partners = new PostgresDesignPartnerStore(database);
  assert.deepEqual(await partners.list("org_one"), []);
  await assert.rejects(partners.recordFeedback({ organizationId: "org_one", partnerId: "partner_other", week: "2026-W34", note: "Useful", activeUse: true, actorUserId: null }), /not found/);
  assert.match(calls[0]!.sql, /organization_id=\$1/);
  assert.deepEqual(calls[1]!.values?.slice(0, 2), ["partner_other", "org_one"]);
});

test("runtime jobs acquire a durable lease and only its owner can finish it", async () => {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  const database: Queryable = { query: async (sql, values) => {
    calls.push({ sql, ...(values ? { values } : {}) });
    return { rows: [{ name: "daily-scan" }], rowCount: 1, command: "", oid: 0, fields: [] };
  } };
  const jobs = new PostgresRuntimeJobStore(database);
  assert.equal(await jobs.acquire("daily-scan", "worker-one", 60, new Date("2026-01-01T00:00:00Z")), true);
  await jobs.succeed("daily-scan", "worker-one", new Date("2026-01-01T00:01:00Z"));
  assert.match(calls[0]!.sql, /lease_expires_at<=\$4/);
  assert.deepEqual(calls[1]!.values?.slice(0, 2), ["daily-scan", "worker-one"]);
  assert.match(calls[1]!.sql, /WHERE name=\$1 AND lease_owner=\$2/);
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

test("connector reads and writes are always organization scoped", async () => {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  const database: Queryable = { query: async (sql, values) => {
    calls.push({ sql, ...(values ? { values } : {}) });
    return { rows: sql.includes("RETURNING organization_id") ? [{
      organization_id: "org_a", provider: "github", status: "connected", external_account_id: "installation_1",
      encrypted_credentials: "sealed:v1:value", health: { verified: true }, error_code: null, error_message: null,
      updated_at: "2026-08-24T00:00:00Z"
    }] : [], rowCount: 1, command: "", oid: 0, fields: [] };
  } };
  const tenants = new PostgresTenantStore(database);
  const saved = await tenants.upsertConnector({ organizationId: "org_a", provider: "github", status: "connected",
    externalAccountId: "installation_1", encryptedCredentials: "sealed:v1:value", health: { verified: true } });
  assert.equal(saved.organizationId, "org_a");
  assert.equal(saved.encryptedCredentials, "sealed:v1:value");
  await tenants.getConnector("org_b", "github");
  await tenants.listConnectors("org_b");
  assert.match(calls[0]!.sql, /WHERE EXISTS \(SELECT 1 FROM organizations WHERE id=\$1\)/);
  assert.equal(calls[0]!.values?.[0], "org_a");
  assert.deepEqual(calls[1]!.values, ["org_b", "github"]);
  assert.match(calls[1]!.sql, /organization_id=\$1 AND provider=\$2/);
  assert.deepEqual(calls[2]!.values, ["org_b"]);
  assert.match(calls[2]!.sql, /WHERE organization_id=\$1/);
});

test("connector health updates preserve omitted encrypted credentials", async () => {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  const database: Queryable = { query: async (sql, values) => {
    calls.push({ sql, ...(values ? { values } : {}) });
    return { rows: [{ organization_id: "org_a", provider: "posthog", status: "connected", external_account_id: null,
      encrypted_credentials: "sealed", health: {}, error_code: null, error_message: null, updated_at: "2026-08-24" }],
      rowCount: 1, command: "", oid: 0, fields: [] };
  } };
  await new PostgresTenantStore(database).upsertConnector({ organizationId: "org_a", provider: "posthog", status: "connected", health: {} });
  assert.match(calls[0]!.sql, /CASE WHEN \$10 THEN EXCLUDED\.encrypted_credentials/);
  assert.equal(calls[0]!.values?.[9], false);
});

test("onboarding records cannot be read or upserted across tenants", async () => {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  const database: Queryable = { query: async (sql, values) => {
    calls.push({ sql, ...(values ? { values } : {}) });
    return { rows: [], rowCount: 0, command: "", oid: 0, fields: [] };
  } };
  const tenants = new PostgresTenantStore(database);
  await assert.rejects(tenants.upsertSiteOnboarding({ organizationId: "org_b", siteId: "site_a", state: "github" }), /not found in organization/);
  assert.equal(await tenants.getSiteOnboarding("org_b", "site_a"), undefined);
  assert.deepEqual(await tenants.listSiteOnboarding("org_b"), []);
  assert.match(calls[0]!.sql, /WHERE EXISTS \(SELECT 1 FROM sites WHERE id=\$2 AND organization_id=\$1\)/);
  assert.match(calls[0]!.sql, /WHERE site_onboarding\.organization_id=EXCLUDED\.organization_id/);
  assert.deepEqual(calls[1]!.values, ["org_b", "site_a"]);
  assert.match(calls[1]!.sql, /organization_id=\$1 AND site_id=\$2/);
  assert.deepEqual(calls[2]!.values, ["org_b"]);
});
