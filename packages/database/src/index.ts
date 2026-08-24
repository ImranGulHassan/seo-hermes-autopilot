import { Pool, type PoolConfig, type QueryResult, type QueryResultRow } from "pg";
import type { ChangeLedger, ChangeRecord, Opportunity, ScanArtifact } from "@seo-autopilot/core";
import type { WebhookDeliveryStore } from "@seo-autopilot/connectors";

export interface Queryable {
  query<R extends QueryResultRow = any>(text: string, values?: unknown[]): Promise<QueryResult<R>>;
}

export function createPool(config: PoolConfig = {}): Pool { return new Pool(config); }
export function siteIdForUrl(siteUrl: string): string { return `site_${Buffer.from(siteUrl).toString("base64url").slice(0, 32)}`; }

export async function migrate(database: Queryable): Promise<void> {
  await database.query(INITIAL_MIGRATION);
}

const INITIAL_MIGRATION = `
CREATE TABLE IF NOT EXISTS sites (
  id text PRIMARY KEY, url text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS runs (
  id text PRIMARY KEY, site_id text NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  started_at timestamptz NOT NULL, completed_at timestamptz NOT NULL,
  data_state text NOT NULL, artifact jsonb NOT NULL
);
ALTER TABLE runs DROP CONSTRAINT IF EXISTS runs_data_state_check;
ALTER TABLE runs ADD CONSTRAINT runs_data_state_check
  CHECK (data_state IN ('technical-only', 'search-performance', 'analytics-enriched'));
CREATE TABLE IF NOT EXISTS opportunities (
  id text PRIMARY KEY, site_id text NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  fingerprint text NOT NULL, type text NOT NULL, estimated_value double precision NOT NULL,
  payload jsonb NOT NULL, first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(), UNIQUE (site_id, fingerprint)
);
CREATE TABLE IF NOT EXISTS changes (
  id text PRIMARY KEY, site_id text REFERENCES sites(id) ON DELETE CASCADE,
  opportunity_id text NOT NULL, fingerprint text NOT NULL, state text NOT NULL,
  github_owner text, github_repository text, github_pr_number integer,
  github_head_branch text, payload jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (github_owner, github_repository, github_pr_number)
);
ALTER TABLE changes ADD COLUMN IF NOT EXISTS site_id text REFERENCES sites(id) ON DELETE CASCADE;
UPDATE changes c SET site_id = o.site_id FROM opportunities o
WHERE c.opportunity_id = o.id AND c.site_id IS NULL;
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  delivery_id text PRIMARY KEY, received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS opportunities_site_value_idx ON opportunities(site_id, estimated_value DESC);
CREATE INDEX IF NOT EXISTS changes_state_idx ON changes(state);
CREATE INDEX IF NOT EXISTS changes_site_state_idx ON changes(site_id, state);
`;

export class PostgresChangeLedger implements ChangeLedger {
  constructor(private readonly database: Queryable, private readonly siteId?: string) {}

  async findByFingerprint(fingerprint: string) { return this.one("SELECT payload FROM changes WHERE fingerprint = $1 ORDER BY updated_at DESC LIMIT 1", [fingerprint]); }
  async get(id: string) { return this.one("SELECT payload FROM changes WHERE id = $1", [id]); }
  async list() {
    const result = this.siteId
      ? await this.database.query<{ payload: ChangeRecord }>("SELECT c.payload FROM changes c WHERE c.site_id=$1 ORDER BY c.updated_at DESC", [this.siteId])
      : await this.database.query<{ payload: ChangeRecord }>("SELECT payload FROM changes ORDER BY updated_at DESC");
    return result.rows.map((row) => row.payload);
  }
  async findByExternalPullRequest(owner: string, repository: string, number: number) {
    return this.one("SELECT payload FROM changes WHERE github_owner = $1 AND github_repository = $2 AND github_pr_number = $3", [owner, repository, number]);
  }
  async save(record: ChangeRecord) {
    const pr = record.externalPullRequest;
    await this.database.query(
      `INSERT INTO changes (id, site_id, opportunity_id, fingerprint, state, github_owner, github_repository, github_pr_number, github_head_branch, payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
       ON CONFLICT (id) DO UPDATE SET site_id=COALESCE(EXCLUDED.site_id,changes.site_id), state=EXCLUDED.state, github_owner=EXCLUDED.github_owner, github_repository=EXCLUDED.github_repository,
       github_pr_number=EXCLUDED.github_pr_number, github_head_branch=EXCLUDED.github_head_branch, payload=EXCLUDED.payload, updated_at=now()`,
      [record.id, this.siteId ?? null, record.opportunityId, record.fingerprint, record.state, pr?.owner ?? null, pr?.repository ?? null, pr?.number ?? null, pr?.headBranch ?? null, JSON.stringify(record)]
    );
  }
  private async one(text: string, values: unknown[]): Promise<ChangeRecord | undefined> {
    return (await this.database.query<{ payload: ChangeRecord }>(text, values)).rows[0]?.payload;
  }
}

export class PostgresWebhookDeliveryStore implements WebhookDeliveryStore {
  constructor(private readonly database: Queryable) {}
  async has(deliveryId: string) { return (await this.database.query("SELECT 1 FROM webhook_deliveries WHERE delivery_id=$1", [deliveryId])).rowCount === 1; }
  async add(deliveryId: string) { await this.database.query("INSERT INTO webhook_deliveries(delivery_id) VALUES($1) ON CONFLICT DO NOTHING", [deliveryId]); }
}

export class PostgresRunStore {
  constructor(private readonly database: Queryable) {}
  async save(artifact: ScanArtifact): Promise<void> {
    const siteId = siteIdForUrl(artifact.siteUrl);
    await this.database.query("INSERT INTO sites(id,url) VALUES($1,$2) ON CONFLICT(url) DO NOTHING", [siteId, artifact.siteUrl]);
    await this.database.query(
      `INSERT INTO runs(id,site_id,started_at,completed_at,data_state,artifact) VALUES($1,(SELECT id FROM sites WHERE url=$2),$3,$4,$5,$6::jsonb)
       ON CONFLICT(id) DO NOTHING`, [artifact.runId, artifact.siteUrl, artifact.startedAt, artifact.completedAt, artifact.dataState, JSON.stringify(artifact)]
    );
    for (const opportunity of artifact.opportunities) await this.saveOpportunity(siteId, opportunity);
  }
  async listOpportunities(siteId?: string): Promise<Opportunity[]> {
    const result = siteId
      ? await this.database.query<{ payload: Opportunity }>("SELECT payload FROM opportunities WHERE site_id=$1 ORDER BY estimated_value DESC", [siteId])
      : await this.database.query<{ payload: Opportunity }>("SELECT payload FROM opportunities ORDER BY estimated_value DESC");
    return result.rows.map((row) => row.payload);
  }
  async listSites(): Promise<Array<{ id: string; url: string; lastRunAt: string | null }>> {
    return (await this.database.query<{ id: string; url: string; last_run_at: Date | string | null }>(
      "SELECT s.id,s.url,max(r.completed_at) AS last_run_at FROM sites s LEFT JOIN runs r ON r.site_id=s.id GROUP BY s.id,s.url ORDER BY last_run_at DESC NULLS LAST,s.url"
    )).rows.map((row) => ({ id: row.id, url: row.url, lastRunAt: row.last_run_at ? new Date(row.last_run_at).toISOString() : null }));
  }
  async listRecent(limit = 30, siteId?: string): Promise<ScanArtifact[]> {
    const safeLimit = Math.max(1, Math.min(Math.trunc(limit), 100));
    const result = siteId
      ? await this.database.query<{ artifact: ScanArtifact }>("SELECT artifact FROM runs WHERE site_id=$1 ORDER BY completed_at DESC LIMIT $2", [siteId, safeLimit])
      : await this.database.query<{ artifact: ScanArtifact }>("SELECT artifact FROM runs ORDER BY completed_at DESC LIMIT $1", [safeLimit]);
    return result.rows.map((row) => row.artifact);
  }
  async listChanges(siteId?: string): Promise<ChangeRecord[]> {
    const result = siteId
      ? await this.database.query<{ payload: ChangeRecord }>("SELECT c.payload FROM changes c WHERE c.site_id=$1 ORDER BY c.updated_at DESC", [siteId])
      : await this.database.query<{ payload: ChangeRecord }>("SELECT payload FROM changes ORDER BY updated_at DESC");
    return result.rows.map((row) => row.payload);
  }
  private async saveOpportunity(siteId: string, opportunity: Opportunity) {
    await this.database.query(
      `INSERT INTO opportunities(id,site_id,fingerprint,type,estimated_value,payload) VALUES($1,$2,$3,$4,$5,$6::jsonb)
       ON CONFLICT(site_id,fingerprint) DO UPDATE SET estimated_value=EXCLUDED.estimated_value,payload=EXCLUDED.payload,last_seen_at=now()`,
      [opportunity.id, siteId, opportunity.fingerprint, opportunity.type, opportunity.estimatedValue, JSON.stringify(opportunity)]
    );
  }
}
