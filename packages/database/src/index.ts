import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Pool, type PoolConfig, type QueryResult, type QueryResultRow } from "pg";
import type { ChangeLedger, ChangeRecord, Opportunity, ScanArtifact } from "@seo-autopilot/core";
import type { WebhookDeliveryStore } from "@seo-autopilot/connectors";

export interface Queryable {
  query<R extends QueryResultRow = any>(text: string, values?: unknown[]): Promise<QueryResult<R>>;
}

export function createPool(config: PoolConfig = {}): Pool { return new Pool(config); }

export async function migrate(database: Queryable): Promise<void> {
  const sql = await readFile(fileURLToPath(new URL("../migrations/001_initial.sql", import.meta.url)), "utf8");
  await database.query(sql);
}

export class PostgresChangeLedger implements ChangeLedger {
  constructor(private readonly database: Queryable) {}

  async findByFingerprint(fingerprint: string) { return this.one("SELECT payload FROM changes WHERE fingerprint = $1 ORDER BY updated_at DESC LIMIT 1", [fingerprint]); }
  async get(id: string) { return this.one("SELECT payload FROM changes WHERE id = $1", [id]); }
  async list() { return (await this.database.query<{ payload: ChangeRecord }>("SELECT payload FROM changes ORDER BY updated_at DESC")).rows.map((row) => row.payload); }
  async findByExternalPullRequest(owner: string, repository: string, number: number) {
    return this.one("SELECT payload FROM changes WHERE github_owner = $1 AND github_repository = $2 AND github_pr_number = $3", [owner, repository, number]);
  }
  async save(record: ChangeRecord) {
    const pr = record.externalPullRequest;
    await this.database.query(
      `INSERT INTO changes (id, opportunity_id, fingerprint, state, github_owner, github_repository, github_pr_number, github_head_branch, payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
       ON CONFLICT (id) DO UPDATE SET state=EXCLUDED.state, github_owner=EXCLUDED.github_owner, github_repository=EXCLUDED.github_repository,
       github_pr_number=EXCLUDED.github_pr_number, github_head_branch=EXCLUDED.github_head_branch, payload=EXCLUDED.payload, updated_at=now()`,
      [record.id, record.opportunityId, record.fingerprint, record.state, pr?.owner ?? null, pr?.repository ?? null, pr?.number ?? null, pr?.headBranch ?? null, JSON.stringify(record)]
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
    const siteId = `site_${Buffer.from(artifact.siteUrl).toString("base64url").slice(0, 32)}`;
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
      ? await this.database.query<{ payload: ChangeRecord }>("SELECT c.payload FROM changes c JOIN opportunities o ON o.id=c.opportunity_id WHERE o.site_id=$1 ORDER BY c.updated_at DESC", [siteId])
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
