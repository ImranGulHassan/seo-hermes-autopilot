import { Pool, type PoolConfig, type QueryResult, type QueryResultRow } from "pg";
import type { ChangeLedger, ChangeRecord, Opportunity, ScanArtifact } from "@seo-autopilot/core";
import type { WebhookDeliveryStore } from "@seo-autopilot/connectors";

export interface Queryable {
  query<R extends QueryResultRow = any>(text: string, values?: unknown[]): Promise<QueryResult<R>>;
}

export function createPool(config: PoolConfig = {}): Pool { return new Pool(config); }
export function siteIdForUrl(siteUrl: string): string { return `site_${Buffer.from(siteUrl).toString("base64url").slice(0, 32)}`; }

export type OrganizationRole = "owner" | "approver" | "viewer";

export interface UserRecord { id: string; email: string; name: string | null; createdAt: string; disabledAt: string | null; }
export interface OrganizationRecord { id: string; slug: string; name: string; createdAt: string; }
export interface MembershipRecord { organizationId: string; userId: string; role: OrganizationRole; createdAt: string; }
export interface SessionRecord { id: string; userId: string; organizationId: string; tokenHash: string; expiresAt: string; createdAt: string; lastSeenAt: string; revokedAt: string | null; }
export interface SiteRecord { id: string; organizationId: string; url: string; createdAt: string; }
export type ConnectorProvider = "github" | "google-search-console" | "posthog";
export type ConnectorStatus = "disconnected" | "pending" | "connected" | "error";
export type OnboardingState = "site" | "github" | "search-console" | "analytics" | "configuration" | "scan" | "complete";
export type ScanState = "not-started" | "queued" | "running" | "complete" | "failed";
export type RuntimeJobName = "daily-scan" | "github-reconcile" | "measurement";
export interface RuntimeJobRecord { name: RuntimeJobName; status: "idle" | "running" | "succeeded" | "failed"; attempts: number; leaseOwner: string | null; leaseExpiresAt: string | null; lastStartedAt: string | null; lastCompletedAt: string | null; lastError: string | null; updatedAt: string; }
export interface ConnectorRecord {
  organizationId: string; provider: ConnectorProvider; status: ConnectorStatus;
  externalAccountId: string | null; encryptedCredentials: string | null;
  health: Record<string, unknown>; errorCode: string | null; errorMessage: string | null; updatedAt: string;
}
export interface SiteOnboardingRecord {
  organizationId: string; siteId: string; state: OnboardingState;
  githubInstallationId: string | null; githubOwner: string | null; githubRepository: string | null; githubBranch: string;
  gscProperty: string | null; posthogProjectId: string | null; protectedPaths: string[];
  scanState: ScanState; scanRunId: string | null; errorCode: string | null; errorMessage: string | null; updatedAt: string;
}
export type PartnerStatus = "invited" | "active" | "suspended" | "completed";
export interface DesignPartnerRecord {
  id: string; organizationId: string; siteId: string | null; name: string; contactEmail: string;
  status: PartnerStatus; startedAt: string | null; pilotEndsAt: string | null;
  publicationPermission: boolean; conversionIntent: "unknown" | "yes" | "no"; convertedAt: string | null;
  weeklyFeedback: Array<{ week: string; note: string; activeUse: boolean; recordedAt: string }>;
  createdAt: string; updatedAt: string;
}
export type BillingPlan = "design-partner" | "starter" | "growth" | "team";
export type BillingStatus = "trialing" | "active" | "past_due" | "canceled" | "unpaid" | "incomplete" | "paused";
export interface BillingRecord {
  organizationId: string; plan: BillingPlan; status: BillingStatus;
  stripeCustomerId: string | null; stripeSubscriptionId: string | null; stripePriceId: string | null;
  currentPeriodStart: string | null; currentPeriodEnd: string | null; cancelAtPeriodEnd: boolean;
  siteLimit: number; monthlyPrLimit: number; updatedAt: string;
}

export async function migrate(database: Queryable): Promise<void> {
  await database.query(INITIAL_MIGRATION);
}

const INITIAL_MIGRATION = `
CREATE TABLE IF NOT EXISTS users (
  id text PRIMARY KEY, email text NOT NULL UNIQUE, name text,
  created_at timestamptz NOT NULL DEFAULT now(), disabled_at timestamptz
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS disabled_at timestamptz;
CREATE TABLE IF NOT EXISTS organizations (
  id text PRIMARY KEY, slug text NOT NULL UNIQUE, name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE organizations ALTER COLUMN slug DROP NOT NULL;
CREATE TABLE IF NOT EXISTS memberships (
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'approver', 'viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, user_id)
);
CREATE TABLE IF NOT EXISTS auth_sessions (
  id text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE, expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE TABLE IF NOT EXISTS login_tokens (
  token_hash text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL, used_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sites (
  id text PRIMARY KEY, url text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE sites ADD COLUMN IF NOT EXISTS organization_id text REFERENCES organizations(id) ON DELETE CASCADE;
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
CREATE INDEX IF NOT EXISTS memberships_user_idx ON memberships(user_id, organization_id);
CREATE INDEX IF NOT EXISTS auth_sessions_user_idx ON auth_sessions(user_id, expires_at DESC);
CREATE INDEX IF NOT EXISTS auth_sessions_organization_idx ON auth_sessions(organization_id, expires_at DESC);
CREATE INDEX IF NOT EXISTS sites_organization_idx ON sites(organization_id, url);
CREATE UNIQUE INDEX IF NOT EXISTS sites_id_organization_uidx ON sites(id, organization_id);
CREATE TABLE IF NOT EXISTS organization_connectors (
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('github', 'google-search-console', 'posthog')),
  status text NOT NULL DEFAULT 'disconnected' CHECK (status IN ('disconnected', 'pending', 'connected', 'error')),
  external_account_id text, encrypted_credentials text, health jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_code text, error_message text, updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, provider)
);
CREATE TABLE IF NOT EXISTS site_onboarding (
  site_id text PRIMARY KEY, organization_id text NOT NULL,
  state text NOT NULL DEFAULT 'site' CHECK (state IN ('site','github','search-console','analytics','configuration','scan','complete')),
  github_installation_id text, github_owner text, github_repository text, github_branch text NOT NULL DEFAULT 'main',
  gsc_property text, posthog_project_id text, protected_paths jsonb NOT NULL DEFAULT '[]'::jsonb,
  scan_state text NOT NULL DEFAULT 'not-started' CHECK (scan_state IN ('not-started','queued','running','complete','failed')),
  scan_run_id text, error_code text, error_message text, updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (site_id, organization_id) REFERENCES sites(id, organization_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS site_onboarding_organization_idx ON site_onboarding(organization_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS runtime_jobs (
  name text PRIMARY KEY CHECK (name IN ('daily-scan','github-reconcile','measurement')),
  status text NOT NULL DEFAULT 'idle' CHECK (status IN ('idle','running','succeeded','failed')),
  attempts integer NOT NULL DEFAULT 0, lease_owner text, lease_expires_at timestamptz,
  last_started_at timestamptz, last_completed_at timestamptz, last_error text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS design_partners (
  id text PRIMARY KEY, organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  site_id text REFERENCES sites(id) ON DELETE SET NULL, name text NOT NULL, contact_email text NOT NULL,
  status text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited','active','suspended','completed')),
  started_at timestamptz, pilot_ends_at timestamptz, publication_permission boolean NOT NULL DEFAULT false,
  conversion_intent text NOT NULL DEFAULT 'unknown' CHECK (conversion_intent IN ('unknown','yes','no')),
  converted_at timestamptz, weekly_feedback jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS design_partners_org_status_idx ON design_partners(organization_id,status,updated_at DESC);
CREATE TABLE IF NOT EXISTS operations_audit (
  id bigserial PRIMARY KEY, organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  actor_user_id text REFERENCES users(id) ON DELETE SET NULL, action text NOT NULL, subject_type text NOT NULL,
  subject_id text NOT NULL, details jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS operations_audit_org_created_idx ON operations_audit(organization_id,created_at DESC);
CREATE TABLE IF NOT EXISTS organization_billing (
  organization_id text PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  plan text NOT NULL DEFAULT 'design-partner' CHECK (plan IN ('design-partner','starter','growth','team')),
  status text NOT NULL DEFAULT 'trialing' CHECK (status IN ('trialing','active','past_due','canceled','unpaid','incomplete','paused')),
  stripe_customer_id text UNIQUE, stripe_subscription_id text UNIQUE, stripe_price_id text,
  current_period_start timestamptz, current_period_end timestamptz, cancel_at_period_end boolean NOT NULL DEFAULT false,
  site_limit integer NOT NULL DEFAULT 5 CHECK (site_limit>0), monthly_pr_limit integer NOT NULL DEFAULT 50 CHECK (monthly_pr_limit>=0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS stripe_webhook_events (
  event_id text PRIMARY KEY, event_type text NOT NULL, received_at timestamptz NOT NULL DEFAULT now(), processed_at timestamptz
);
CREATE TABLE IF NOT EXISTS billing_usage (
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  period_start date NOT NULL, pull_requests integer NOT NULL DEFAULT 0 CHECK (pull_requests>=0),
  PRIMARY KEY(organization_id,period_start)
);
`;

function iso(value: Date | string): string { return new Date(value).toISOString(); }

/** Tenant and authentication persistence. Every site read requires an organization id. */
export class PostgresTenantStore {
  constructor(private readonly database: Queryable) {}

  async createUser(input: { id: string; email: string; name?: string | null }): Promise<UserRecord> {
    const result = await this.database.query<{ id: string; email: string; name: string | null; created_at: Date | string; disabled_at: Date | string | null }>(
      `INSERT INTO users(id,email,name) VALUES($1,lower($2),$3)
       ON CONFLICT(email) DO UPDATE SET name=COALESCE(EXCLUDED.name,users.name)
       RETURNING id,email,name,created_at,disabled_at`, [input.id, input.email, input.name ?? null]
    );
    return this.user(result.rows[0]!);
  }

  async findUserByEmail(email: string): Promise<UserRecord | undefined> {
    const row = (await this.database.query<{ id: string; email: string; name: string | null; created_at: Date | string; disabled_at: Date | string | null }>(
      "SELECT id,email,name,created_at,disabled_at FROM users WHERE email=lower($1)", [email]
    )).rows[0];
    return row ? this.user(row) : undefined;
  }

  async createOrganization(input: { id: string; slug: string; name: string; ownerUserId: string }): Promise<OrganizationRecord> {
    const result = await this.database.query<{ id: string; slug: string; name: string; created_at: Date | string }>(
      `INSERT INTO organizations(id,slug,name) VALUES($1,$2,$3)
       ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name
       RETURNING id,slug,name,created_at`,
      [input.id, input.slug, input.name]
    );
    await this.addMembership({ organizationId: input.id, userId: input.ownerUserId, role: "owner" });
    const row = result.rows[0]!;
    return { id: row.id, slug: row.slug, name: row.name, createdAt: iso(row.created_at) };
  }

  async addMembership(input: { organizationId: string; userId: string; role: OrganizationRole }): Promise<void> {
    await this.database.query(
      `INSERT INTO memberships(organization_id,user_id,role) VALUES($1,$2,$3)
       ON CONFLICT(organization_id,user_id) DO UPDATE SET role=EXCLUDED.role`,
      [input.organizationId, input.userId, input.role]
    );
  }

  async listMemberships(userId: string): Promise<MembershipRecord[]> {
    const result = await this.database.query<{ organization_id: string; user_id: string; role: OrganizationRole; created_at: Date | string }>(
      "SELECT organization_id,user_id,role,created_at FROM memberships WHERE user_id=$1 ORDER BY created_at", [userId]
    );
    return result.rows.map((row) => ({ organizationId: row.organization_id, userId: row.user_id, role: row.role, createdAt: iso(row.created_at) }));
  }

  async getMembership(userId: string, organizationId: string): Promise<MembershipRecord | undefined> {
    const row = (await this.database.query<{ organization_id: string; user_id: string; role: OrganizationRole; created_at: Date | string }>(
      "SELECT organization_id,user_id,role,created_at FROM memberships WHERE user_id=$1 AND organization_id=$2", [userId, organizationId]
    )).rows[0];
    return row ? { organizationId: row.organization_id, userId: row.user_id, role: row.role, createdAt: iso(row.created_at) } : undefined;
  }

  async createSession(input: { id: string; userId: string; organizationId: string; tokenHash: string; expiresAt: string }): Promise<SessionRecord> {
    const row = (await this.database.query<{ id: string; user_id: string; organization_id: string; token_hash: string; expires_at: Date | string; created_at: Date | string; last_seen_at: Date | string; revoked_at: Date | string | null }>(
      `INSERT INTO auth_sessions(id,user_id,organization_id,token_hash,expires_at) VALUES($1,$2,$3,$4,$5)
       RETURNING id,user_id,organization_id,token_hash,expires_at,created_at,last_seen_at,revoked_at`,
      [input.id, input.userId, input.organizationId, input.tokenHash, input.expiresAt]
    )).rows[0]!;
    return this.session(row);
  }

  async findActiveSession(tokenHash: string, at = new Date()): Promise<SessionRecord | undefined> {
    const row = (await this.database.query<{ id: string; user_id: string; organization_id: string; token_hash: string; expires_at: Date | string; created_at: Date | string; last_seen_at: Date | string; revoked_at: Date | string | null }>(
      `SELECT id,user_id,organization_id,token_hash,expires_at,created_at,last_seen_at,revoked_at FROM auth_sessions
       WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>$2`, [tokenHash, at.toISOString()]
    )).rows[0];
    return row ? this.session(row) : undefined;
  }

  async revokeSession(id: string, userId: string): Promise<void> {
    await this.database.query("UPDATE auth_sessions SET revoked_at=now() WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL", [id, userId]);
  }

  async createSite(input: { id?: string; organizationId: string; url: string }): Promise<SiteRecord> {
    const id = input.id ?? siteIdForUrl(input.url);
    const row = (await this.database.query<{ id: string; organization_id: string; url: string; created_at: Date | string }>(
      `INSERT INTO sites(id,organization_id,url) VALUES($1,$2,$3)
       ON CONFLICT(url) DO UPDATE SET url=EXCLUDED.url
       RETURNING id,organization_id,url,created_at`, [id, input.organizationId, input.url]
    )).rows[0]!;
    if (row.organization_id !== input.organizationId) throw new Error("Site belongs to another organization");
    return { id: row.id, organizationId: row.organization_id, url: row.url, createdAt: iso(row.created_at) };
  }

  async getSite(organizationId: string, siteId: string): Promise<SiteRecord | undefined> {
    const row = (await this.database.query<{ id: string; organization_id: string; url: string; created_at: Date | string }>(
      "SELECT id,organization_id,url,created_at FROM sites WHERE id=$1 AND organization_id=$2", [siteId, organizationId]
    )).rows[0];
    return row ? { id: row.id, organizationId: row.organization_id, url: row.url, createdAt: iso(row.created_at) } : undefined;
  }

  async listSites(organizationId: string): Promise<SiteRecord[]> {
    const result = await this.database.query<{ id: string; organization_id: string; url: string; created_at: Date | string }>(
      "SELECT id,organization_id,url,created_at FROM sites WHERE organization_id=$1 ORDER BY url", [organizationId]
    );
    return result.rows.map((row) => ({ id: row.id, organizationId: row.organization_id, url: row.url, createdAt: iso(row.created_at) }));
  }

  async upsertConnector(input: {
    organizationId: string; provider: ConnectorProvider; status: ConnectorStatus;
    externalAccountId?: string | null; encryptedCredentials?: string | null;
    health?: Record<string, unknown>; errorCode?: string | null; errorMessage?: string | null;
  }): Promise<ConnectorRecord> {
    const row = (await this.database.query<ConnectorRow>(
      `INSERT INTO organization_connectors
       (organization_id,provider,status,external_account_id,encrypted_credentials,health,error_code,error_message)
       SELECT $1,$2,$3,$4,$5,$6::jsonb,$7,$8 WHERE EXISTS (SELECT 1 FROM organizations WHERE id=$1)
       ON CONFLICT(organization_id,provider) DO UPDATE SET status=EXCLUDED.status,
       external_account_id=CASE WHEN $9 THEN EXCLUDED.external_account_id ELSE organization_connectors.external_account_id END,
       encrypted_credentials=CASE WHEN $10 THEN EXCLUDED.encrypted_credentials ELSE organization_connectors.encrypted_credentials END,
       health=CASE WHEN $11 THEN EXCLUDED.health ELSE organization_connectors.health END,
       error_code=EXCLUDED.error_code, error_message=EXCLUDED.error_message, updated_at=now()
       RETURNING organization_id,provider,status,external_account_id,encrypted_credentials,health,error_code,error_message,updated_at`,
      [input.organizationId, input.provider, input.status, input.externalAccountId ?? null,
        input.encryptedCredentials ?? null, JSON.stringify(input.health ?? {}), input.errorCode ?? null, input.errorMessage ?? null,
        "externalAccountId" in input, "encryptedCredentials" in input, "health" in input]
    )).rows[0];
    if (!row) throw new Error("Organization not found");
    return this.connector(row);
  }

  async getConnector(organizationId: string, provider: ConnectorProvider): Promise<ConnectorRecord | undefined> {
    const row = (await this.database.query<ConnectorRow>(
      `SELECT organization_id,provider,status,external_account_id,encrypted_credentials,health,error_code,error_message,updated_at
       FROM organization_connectors WHERE organization_id=$1 AND provider=$2`, [organizationId, provider]
    )).rows[0];
    return row ? this.connector(row) : undefined;
  }

  async listConnectors(organizationId: string): Promise<ConnectorRecord[]> {
    const result = await this.database.query<ConnectorRow>(
      `SELECT organization_id,provider,status,external_account_id,encrypted_credentials,health,error_code,error_message,updated_at
       FROM organization_connectors WHERE organization_id=$1 ORDER BY provider`, [organizationId]
    );
    return result.rows.map((row) => this.connector(row));
  }

  async upsertSiteOnboarding(input: {
    organizationId: string; siteId: string; state?: OnboardingState;
    githubInstallationId?: string | null; githubOwner?: string | null; githubRepository?: string | null; githubBranch?: string;
    gscProperty?: string | null; posthogProjectId?: string | null; protectedPaths?: string[];
    scanState?: ScanState; scanRunId?: string | null; errorCode?: string | null; errorMessage?: string | null;
  }): Promise<SiteOnboardingRecord> {
    const row = (await this.database.query<SiteOnboardingRow>(
      `INSERT INTO site_onboarding
       (site_id,organization_id,state,github_installation_id,github_owner,github_repository,github_branch,
        gsc_property,posthog_project_id,protected_paths,scan_state,scan_run_id,error_code,error_message)
       SELECT $2,$1,COALESCE($3,'site'),$4,$5,$6,COALESCE($7,'main'),$8,$9,COALESCE($10::jsonb,'[]'::jsonb),
        COALESCE($11,'not-started'),$12,$13,$14
       WHERE EXISTS (SELECT 1 FROM sites WHERE id=$2 AND organization_id=$1)
       ON CONFLICT(site_id) DO UPDATE SET state=COALESCE($3,site_onboarding.state),
       github_installation_id=COALESCE($4,site_onboarding.github_installation_id),
       github_owner=COALESCE($5,site_onboarding.github_owner), github_repository=COALESCE($6,site_onboarding.github_repository),
       github_branch=COALESCE($7,site_onboarding.github_branch), gsc_property=COALESCE($8,site_onboarding.gsc_property),
       posthog_project_id=COALESCE($9,site_onboarding.posthog_project_id),
       protected_paths=COALESCE($10::jsonb,site_onboarding.protected_paths), scan_state=COALESCE($11,site_onboarding.scan_state),
       scan_run_id=COALESCE($12,site_onboarding.scan_run_id), error_code=$13, error_message=$14, updated_at=now()
       WHERE site_onboarding.organization_id=EXCLUDED.organization_id
       RETURNING site_id,organization_id,state,github_installation_id,github_owner,github_repository,github_branch,
       gsc_property,posthog_project_id,protected_paths,scan_state,scan_run_id,error_code,error_message,updated_at`,
      [input.organizationId, input.siteId, input.state ?? null, input.githubInstallationId ?? null, input.githubOwner ?? null,
        input.githubRepository ?? null, input.githubBranch ?? null, input.gscProperty ?? null, input.posthogProjectId ?? null,
        input.protectedPaths ? JSON.stringify(input.protectedPaths) : null, input.scanState ?? null, input.scanRunId ?? null,
        input.errorCode ?? null, input.errorMessage ?? null]
    )).rows[0];
    if (!row) throw new Error("Site not found in organization");
    return this.onboarding(row);
  }

  async getSiteOnboarding(organizationId: string, siteId: string): Promise<SiteOnboardingRecord | undefined> {
    const row = (await this.database.query<SiteOnboardingRow>(
      `SELECT site_id,organization_id,state,github_installation_id,github_owner,github_repository,github_branch,
       gsc_property,posthog_project_id,protected_paths,scan_state,scan_run_id,error_code,error_message,updated_at
       FROM site_onboarding WHERE organization_id=$1 AND site_id=$2`, [organizationId, siteId]
    )).rows[0];
    return row ? this.onboarding(row) : undefined;
  }

  async listSiteOnboarding(organizationId: string): Promise<SiteOnboardingRecord[]> {
    const result = await this.database.query<SiteOnboardingRow>(
      `SELECT site_id,organization_id,state,github_installation_id,github_owner,github_repository,github_branch,
       gsc_property,posthog_project_id,protected_paths,scan_state,scan_run_id,error_code,error_message,updated_at
       FROM site_onboarding WHERE organization_id=$1 ORDER BY updated_at DESC`, [organizationId]
    );
    return result.rows.map((row) => this.onboarding(row));
  }

  private user(row: { id: string; email: string; name: string | null; created_at: Date | string; disabled_at?: Date | string | null }): UserRecord {
    return { id: row.id, email: row.email, name: row.name, createdAt: iso(row.created_at), disabledAt: row.disabled_at ? iso(row.disabled_at) : null };
  }
  private session(row: { id: string; user_id: string; organization_id: string; token_hash: string; expires_at: Date | string; created_at: Date | string; last_seen_at: Date | string; revoked_at: Date | string | null }): SessionRecord {
    return { id: row.id, userId: row.user_id, organizationId: row.organization_id, tokenHash: row.token_hash, expiresAt: iso(row.expires_at), createdAt: iso(row.created_at), lastSeenAt: iso(row.last_seen_at), revokedAt: row.revoked_at ? iso(row.revoked_at) : null };
  }
  private connector(row: ConnectorRow): ConnectorRecord {
    return { organizationId: row.organization_id, provider: row.provider, status: row.status,
      externalAccountId: row.external_account_id, encryptedCredentials: row.encrypted_credentials, health: row.health ?? {},
      errorCode: row.error_code, errorMessage: row.error_message, updatedAt: iso(row.updated_at) };
  }
  private onboarding(row: SiteOnboardingRow): SiteOnboardingRecord {
    return { organizationId: row.organization_id, siteId: row.site_id, state: row.state,
      githubInstallationId: row.github_installation_id, githubOwner: row.github_owner, githubRepository: row.github_repository,
      githubBranch: row.github_branch, gscProperty: row.gsc_property, posthogProjectId: row.posthog_project_id,
      protectedPaths: row.protected_paths ?? [], scanState: row.scan_state, scanRunId: row.scan_run_id,
      errorCode: row.error_code, errorMessage: row.error_message, updatedAt: iso(row.updated_at) };
  }
}

/** Database-backed singleton leases make serverless cron invocations idempotent and observable. */
export class PostgresDesignPartnerStore {
  constructor(private readonly database: Queryable) {}

  async list(organizationId: string): Promise<DesignPartnerRecord[]> {
    const result = await this.database.query<any>(`SELECT * FROM design_partners WHERE organization_id=$1 ORDER BY created_at DESC`, [organizationId]);
    return result.rows.map(partnerRecord);
  }

  async upsert(input: { id: string; organizationId: string; siteId?: string | null; name: string; contactEmail: string; status?: PartnerStatus; publicationPermission?: boolean; conversionIntent?: "unknown" | "yes" | "no"; startedAt?: string | null; pilotEndsAt?: string | null; convertedAt?: string | null }): Promise<DesignPartnerRecord> {
    const row = (await this.database.query<any>(`INSERT INTO design_partners(id,organization_id,site_id,name,contact_email,status,started_at,pilot_ends_at,publication_permission,conversion_intent,converted_at)
      SELECT $1,$2,$3,$4,lower($5),COALESCE($6,'invited'),$7,$8,COALESCE($9,false),COALESCE($10,'unknown'),$11
      WHERE $3 IS NULL OR EXISTS (SELECT 1 FROM sites WHERE id=$3 AND organization_id=$2)
      ON CONFLICT(id) DO UPDATE SET site_id=EXCLUDED.site_id,name=EXCLUDED.name,contact_email=EXCLUDED.contact_email,status=EXCLUDED.status,
      started_at=COALESCE(EXCLUDED.started_at,design_partners.started_at),pilot_ends_at=COALESCE(EXCLUDED.pilot_ends_at,design_partners.pilot_ends_at),
      publication_permission=EXCLUDED.publication_permission,conversion_intent=EXCLUDED.conversion_intent,converted_at=EXCLUDED.converted_at,updated_at=now()
      WHERE design_partners.organization_id=EXCLUDED.organization_id RETURNING *`, [input.id,input.organizationId,input.siteId ?? null,input.name,input.contactEmail,input.status ?? null,input.startedAt ?? null,input.pilotEndsAt ?? null,input.publicationPermission ?? false,input.conversionIntent ?? "unknown",input.convertedAt ?? null])).rows[0];
    if (!row) throw new Error("Partner site is not in the organization");
    return partnerRecord(row);
  }

  async recordFeedback(input: { organizationId: string; partnerId: string; week: string; note: string; activeUse: boolean; actorUserId: string | null; recordedAt?: string }): Promise<DesignPartnerRecord> {
    const entry = { week: input.week, note: input.note, activeUse: input.activeUse, recordedAt: input.recordedAt ?? new Date().toISOString() };
    const row = (await this.database.query<any>(`UPDATE design_partners SET weekly_feedback=weekly_feedback || $3::jsonb,updated_at=now() WHERE id=$1 AND organization_id=$2 RETURNING *`, [input.partnerId,input.organizationId,JSON.stringify([entry])])).rows[0];
    if (!row) throw new Error("Partner not found");
    await this.audit(input.organizationId,input.actorUserId,"partner.feedback-recorded","design-partner",input.partnerId,{ week: input.week, activeUse: input.activeUse });
    return partnerRecord(row);
  }

  async audit(organizationId: string, actorUserId: string | null, action: string, subjectType: string, subjectId: string, details: Record<string, unknown> = {}): Promise<void> {
    await this.database.query(`INSERT INTO operations_audit(organization_id,actor_user_id,action,subject_type,subject_id,details) VALUES($1,$2,$3,$4,$5,$6::jsonb)`, [organizationId,actorUserId,action,subjectType,subjectId,JSON.stringify(details)]);
  }

  async listAudit(organizationId: string, limit = 100): Promise<Array<{ action: string; subjectType: string; subjectId: string; details: Record<string, unknown>; createdAt: string }>> {
    const result = await this.database.query<any>(`SELECT action,subject_type,subject_id,details,created_at FROM operations_audit WHERE organization_id=$1 ORDER BY created_at DESC LIMIT $2`, [organizationId,Math.max(1,Math.min(limit,500))]);
    return result.rows.map((row) => ({ action: row.action, subjectType: row.subject_type, subjectId: row.subject_id, details: row.details, createdAt: iso(row.created_at) }));
  }
}

function partnerRecord(row: any): DesignPartnerRecord {
  return { id: row.id, organizationId: row.organization_id, siteId: row.site_id, name: row.name, contactEmail: row.contact_email, status: row.status,
    startedAt: row.started_at ? iso(row.started_at) : null, pilotEndsAt: row.pilot_ends_at ? iso(row.pilot_ends_at) : null,
    publicationPermission: row.publication_permission, conversionIntent: row.conversion_intent, convertedAt: row.converted_at ? iso(row.converted_at) : null,
    weeklyFeedback: row.weekly_feedback ?? [], createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) };
}

export const BILLING_LIMITS: Record<BillingPlan, { sites: number; monthlyPullRequests: number }> = {
  "design-partner": { sites: 5, monthlyPullRequests: 50 }, starter: { sites: 1, monthlyPullRequests: 10 },
  growth: { sites: 5, monthlyPullRequests: 50 }, team: { sites: 25, monthlyPullRequests: 200 }
};

export class PostgresBillingStore {
  constructor(private readonly database: Queryable) {}
  async get(organizationId: string): Promise<BillingRecord | undefined> {
    const row = (await this.database.query<any>("SELECT * FROM organization_billing WHERE organization_id=$1", [organizationId])).rows[0];
    return row ? billingRecord(row) : undefined;
  }
  async ensureDesignPartner(organizationId: string): Promise<BillingRecord> {
    const limits = BILLING_LIMITS["design-partner"];
    const row = (await this.database.query<any>(`INSERT INTO organization_billing(organization_id,plan,status,site_limit,monthly_pr_limit)
      SELECT $1,'design-partner','trialing',$2,$3 WHERE EXISTS(SELECT 1 FROM organizations WHERE id=$1)
      ON CONFLICT(organization_id) DO UPDATE SET organization_id=EXCLUDED.organization_id RETURNING *`, [organizationId,limits.sites,limits.monthlyPullRequests])).rows[0];
    if (!row) throw new Error("Organization not found"); return billingRecord(row);
  }
  async reconcile(input: { eventId: string; eventType: string; organizationId: string; plan: BillingPlan; status: BillingStatus; customerId: string | null; subscriptionId: string | null; priceId: string | null; currentPeriodStart?: string | null; currentPeriodEnd?: string | null; cancelAtPeriodEnd?: boolean }): Promise<boolean> {
    const limits = BILLING_LIMITS[input.plan];
    const result = await this.database.query<any>(`WITH claimed AS (
      INSERT INTO stripe_webhook_events(event_id,event_type) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING event_id
    ), saved AS (
      INSERT INTO organization_billing(organization_id,plan,status,stripe_customer_id,stripe_subscription_id,stripe_price_id,current_period_start,current_period_end,cancel_at_period_end,site_limit,monthly_pr_limit)
      SELECT $3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13 FROM claimed WHERE EXISTS(SELECT 1 FROM organizations WHERE id=$3)
      ON CONFLICT(organization_id) DO UPDATE SET plan=EXCLUDED.plan,status=EXCLUDED.status,stripe_customer_id=COALESCE(EXCLUDED.stripe_customer_id,organization_billing.stripe_customer_id),stripe_subscription_id=COALESCE(EXCLUDED.stripe_subscription_id,organization_billing.stripe_subscription_id),stripe_price_id=COALESCE(EXCLUDED.stripe_price_id,organization_billing.stripe_price_id),current_period_start=COALESCE(EXCLUDED.current_period_start,organization_billing.current_period_start),current_period_end=COALESCE(EXCLUDED.current_period_end,organization_billing.current_period_end),cancel_at_period_end=EXCLUDED.cancel_at_period_end,site_limit=EXCLUDED.site_limit,monthly_pr_limit=EXCLUDED.monthly_pr_limit,updated_at=now() RETURNING organization_id
    ) UPDATE stripe_webhook_events SET processed_at=now() WHERE event_id=$1 AND EXISTS(SELECT 1 FROM saved) RETURNING event_id`, [input.eventId,input.eventType,input.organizationId,input.plan,input.status,input.customerId,input.subscriptionId,input.priceId,input.currentPeriodStart ?? null,input.currentPeriodEnd ?? null,input.cancelAtPeriodEnd ?? false,limits.sites,limits.monthlyPullRequests]);
    return result.rowCount === 1;
  }
  async entitlement(organizationId: string): Promise<{ billing: BillingRecord; sitesUsed: number; pullRequestsUsed: number; canAddSite: boolean; canOpenPullRequest: boolean }> {
    const billing = await this.get(organizationId) ?? await this.ensureDesignPartner(organizationId);
    const sitesUsed = Number((await this.database.query<{ count: string }>("SELECT count(*)::text count FROM sites WHERE organization_id=$1", [organizationId])).rows[0]?.count ?? 0);
    const pullRequestsUsed = Number((await this.database.query<{ count: string }>(`SELECT count(*)::text count FROM changes c JOIN sites s ON s.id=c.site_id WHERE s.organization_id=$1 AND c.github_pr_number IS NOT NULL AND c.updated_at>=date_trunc('month',now())`, [organizationId])).rows[0]?.count ?? 0);
    const paid = ["active","trialing"].includes(billing.status);
    return { billing, sitesUsed, pullRequestsUsed, canAddSite: paid && sitesUsed < billing.siteLimit, canOpenPullRequest: paid && pullRequestsUsed < billing.monthlyPrLimit };
  }
}

function billingRecord(row: any): BillingRecord { return { organizationId: row.organization_id, plan: row.plan, status: row.status, stripeCustomerId: row.stripe_customer_id, stripeSubscriptionId: row.stripe_subscription_id, stripePriceId: row.stripe_price_id, currentPeriodStart: row.current_period_start ? iso(row.current_period_start) : null, currentPeriodEnd: row.current_period_end ? iso(row.current_period_end) : null, cancelAtPeriodEnd: row.cancel_at_period_end, siteLimit: row.site_limit, monthlyPrLimit: row.monthly_pr_limit, updatedAt: iso(row.updated_at) }; }

export class PostgresRuntimeJobStore {
  constructor(private readonly database: Queryable) {}
  async acquire(name: RuntimeJobName, owner: string, leaseSeconds = 300, now = new Date()): Promise<boolean> {
    const result = await this.database.query(
      `INSERT INTO runtime_jobs(name,status,attempts,lease_owner,lease_expires_at,last_started_at)
       VALUES($1,'running',1,$2,$3,$4)
       ON CONFLICT(name) DO UPDATE SET status='running',attempts=runtime_jobs.attempts+1,
       lease_owner=EXCLUDED.lease_owner,lease_expires_at=EXCLUDED.lease_expires_at,
       last_started_at=EXCLUDED.last_started_at,last_error=NULL,updated_at=now()
       WHERE runtime_jobs.status<>'running' OR runtime_jobs.lease_expires_at<=$4
       RETURNING name`, [name, owner, new Date(now.getTime() + leaseSeconds * 1000).toISOString(), now.toISOString()]
    );
    return result.rowCount === 1;
  }
  async succeed(name: RuntimeJobName, owner: string, now = new Date()): Promise<void> {
    await this.database.query(`UPDATE runtime_jobs SET status='succeeded',lease_owner=NULL,lease_expires_at=NULL,last_completed_at=$3,updated_at=now() WHERE name=$1 AND lease_owner=$2`, [name, owner, now.toISOString()]);
  }
  async fail(name: RuntimeJobName, owner: string, error: string): Promise<void> {
    await this.database.query(`UPDATE runtime_jobs SET status='failed',lease_owner=NULL,lease_expires_at=NULL,last_error=$3,updated_at=now() WHERE name=$1 AND lease_owner=$2`, [name, owner, error.slice(0, 4000)]);
  }
  async list(): Promise<RuntimeJobRecord[]> {
    const rows = await this.database.query<any>(`SELECT name,status,attempts,lease_owner,lease_expires_at,last_started_at,last_completed_at,last_error,updated_at FROM runtime_jobs ORDER BY name`);
    return rows.rows.map((row) => ({ name: row.name, status: row.status, attempts: row.attempts, leaseOwner: row.lease_owner, leaseExpiresAt: row.lease_expires_at ? iso(row.lease_expires_at) : null, lastStartedAt: row.last_started_at ? iso(row.last_started_at) : null, lastCompletedAt: row.last_completed_at ? iso(row.last_completed_at) : null, lastError: row.last_error, updatedAt: iso(row.updated_at) }));
  }
}

interface ConnectorRow { organization_id: string; provider: ConnectorProvider; status: ConnectorStatus; external_account_id: string | null; encrypted_credentials: string | null; health: Record<string, unknown>; error_code: string | null; error_message: string | null; updated_at: Date | string; }
interface SiteOnboardingRow { site_id: string; organization_id: string; state: OnboardingState; github_installation_id: string | null; github_owner: string | null; github_repository: string | null; github_branch: string; gsc_property: string | null; posthog_project_id: string | null; protected_paths: string[]; scan_state: ScanState; scan_run_id: string | null; error_code: string | null; error_message: string | null; updated_at: Date | string; }

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
  async save(artifact: ScanArtifact, organizationId?: string): Promise<void> {
    const siteId = siteIdForUrl(artifact.siteUrl);
    await this.database.query("INSERT INTO sites(id,url,organization_id) VALUES($1,$2,$3) ON CONFLICT(url) DO NOTHING", [siteId, artifact.siteUrl, organizationId ?? null]);
    if (organizationId) {
      const owned = await this.database.query("SELECT 1 FROM sites WHERE url=$1 AND organization_id=$2", [artifact.siteUrl, organizationId]);
      if (owned.rowCount !== 1) throw new Error("Site belongs to another organization");
    }
    await this.database.query(
      `INSERT INTO runs(id,site_id,started_at,completed_at,data_state,artifact) VALUES($1,(SELECT id FROM sites WHERE url=$2),$3,$4,$5,$6::jsonb)
       ON CONFLICT(id) DO NOTHING`, [artifact.runId, artifact.siteUrl, artifact.startedAt, artifact.completedAt, artifact.dataState, JSON.stringify(artifact)]
    );
    for (const opportunity of artifact.opportunities) await this.saveOpportunity(siteId, opportunity);
  }
  async listOpportunities(organizationId: string, siteId?: string): Promise<Opportunity[]> {
    const result = siteId
      ? await this.database.query<{ payload: Opportunity }>("SELECT o.payload FROM opportunities o JOIN sites s ON s.id=o.site_id WHERE s.organization_id=$1 AND o.site_id=$2 ORDER BY o.estimated_value DESC", [organizationId, siteId])
      : await this.database.query<{ payload: Opportunity }>("SELECT o.payload FROM opportunities o JOIN sites s ON s.id=o.site_id WHERE s.organization_id=$1 ORDER BY o.estimated_value DESC", [organizationId]);
    return result.rows.map((row) => row.payload);
  }
  async listSites(organizationId: string): Promise<Array<{ id: string; url: string; lastRunAt: string | null }>> {
    return (await this.database.query<{ id: string; url: string; last_run_at: Date | string | null }>(
      "SELECT s.id,s.url,max(r.completed_at) AS last_run_at FROM sites s LEFT JOIN runs r ON r.site_id=s.id WHERE s.organization_id=$1 GROUP BY s.id,s.url ORDER BY last_run_at DESC NULLS LAST,s.url", [organizationId]
    )).rows.map((row) => ({ id: row.id, url: row.url, lastRunAt: row.last_run_at ? new Date(row.last_run_at).toISOString() : null }));
  }
  async listRecent(organizationId: string, limit = 30, siteId?: string): Promise<ScanArtifact[]> {
    const safeLimit = Math.max(1, Math.min(Math.trunc(limit), 100));
    const result = siteId
      ? await this.database.query<{ artifact: ScanArtifact }>("SELECT r.artifact FROM runs r JOIN sites s ON s.id=r.site_id WHERE s.organization_id=$1 AND r.site_id=$2 ORDER BY r.completed_at DESC LIMIT $3", [organizationId, siteId, safeLimit])
      : await this.database.query<{ artifact: ScanArtifact }>("SELECT r.artifact FROM runs r JOIN sites s ON s.id=r.site_id WHERE s.organization_id=$1 ORDER BY r.completed_at DESC LIMIT $2", [organizationId, safeLimit]);
    return result.rows.map((row) => row.artifact);
  }
  async listChanges(organizationId: string, siteId?: string): Promise<ChangeRecord[]> {
    const result = siteId
      ? await this.database.query<{ payload: ChangeRecord }>("SELECT c.payload FROM changes c JOIN sites s ON s.id=c.site_id WHERE s.organization_id=$1 AND c.site_id=$2 ORDER BY c.updated_at DESC", [organizationId, siteId])
      : await this.database.query<{ payload: ChangeRecord }>("SELECT c.payload FROM changes c JOIN sites s ON s.id=c.site_id WHERE s.organization_id=$1 ORDER BY c.updated_at DESC", [organizationId]);
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
