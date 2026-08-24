import { randomUUID } from "node:crypto";
import { GitHubAppAuthenticator, GitHubAppClient, GoogleOAuthTokenProvider, GoogleSearchConsoleClient, completedSearchWindow, reconcileGitHubChanges } from "@seo-autopilot/connectors";
import { ChangeWorkflow, runMeasurementSchedule, type ChangeRecord, type MetricBaseline } from "@seo-autopilot/core";
import { PostgresChangeLedger, PostgresRuntimeJobStore, type RuntimeJobName, siteIdForUrl } from "@seo-autopilot/database";
import { decryptCredential } from "./onboarding/credentials";
import { onboardingRuntime, runFirstScan } from "./onboarding/runtime";

export function authorizeCron(request: Request, secret = process.env.CRON_SECRET): boolean {
  if (!secret) return false;
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

export async function executeRuntimeJob(name: RuntimeJobName) {
  const runtime = await onboardingRuntime();
  const jobs = new PostgresRuntimeJobStore(runtime.pool);
  const owner = randomUUID();
  if (!(await jobs.acquire(name, owner, 14 * 60))) return { status: "leased" as const };
  try {
    const operation: () => Promise<unknown> = name === "daily-scan" ? dailyScans : name === "github-reconcile" ? githubReconcile : measurements;
    const result = await withRetries(operation);
    await jobs.succeed(name, owner);
    return { status: "succeeded" as const, result };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await jobs.fail(name, owner, message);
    throw error;
  }
}

export async function withRetries<T>(operation: () => Promise<T>, maxAttempts = 3): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try { return await operation(); } catch (error) { lastError = error; }
  }
  throw lastError;
}

async function eligibleSites() {
  const runtime = await onboardingRuntime();
  const rows = await runtime.pool.query<{ organization_id: string; site_id: string }>("SELECT organization_id,site_id FROM site_onboarding WHERE state='complete' AND scan_state='complete' ORDER BY site_id");
  return rows.rows;
}

async function dailyScans() {
  const runtime = await onboardingRuntime();
  const completed: string[] = [], errors: Array<{ siteId: string; error: string }> = [];
  for (const row of await eligibleSites()) try {
    await runFirstScan({ sessionId: "cron", userId: "cron", email: "cron@internal", name: "Scheduler", organizationId: row.organization_id, organizationName: "", role: "owner", expiresAt: new Date(Date.now() + 60_000), lastSeenAt: new Date() }, row.site_id);
    completed.push(row.site_id);
  } catch (error) { errors.push({ siteId: row.site_id, error: error instanceof Error ? error.message : String(error) }); }
  if (errors.length) throw new Error(`Daily scan failures: ${JSON.stringify(errors)}`);
  return { completed };
}

async function githubReconcile() {
  const runtime = await onboardingRuntime();
  const appId = process.env.GITHUB_APP_ID, privateKey = process.env.GITHUB_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (!appId || !privateKey) throw new Error("GITHUB_APP_ID and GITHUB_PRIVATE_KEY are required.");
  const rows = await runtime.pool.query<{ site_id: string; github_installation_id: string }>("SELECT site_id,github_installation_id FROM site_onboarding WHERE github_installation_id IS NOT NULL");
  const results = [];
  for (const row of rows.rows) {
    const ledger = new PostgresChangeLedger(runtime.pool, row.site_id);
    const github = new GitHubAppClient({ tokenProvider: new GitHubAppAuthenticator({ appId, installationId: row.github_installation_id, privateKey }) });
    results.push(await reconcileGitHubChanges({ ledger, workflow: new ChangeWorkflow(ledger), github }));
  }
  const failures = results.flatMap((result) => result.errors);
  if (failures.length) throw new Error(`GitHub reconciliation failures: ${JSON.stringify(failures)}`);
  return { sites: rows.rowCount, advanced: results.flatMap((result) => result.advanced).length };
}

async function measurements() {
  const runtime = await onboardingRuntime();
  const clientId = process.env.GOOGLE_CLIENT_ID, clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("Google OAuth credentials are required.");
  const rows = await runtime.pool.query<{ organization_id: string; site_id: string; url: string; gsc_property: string; encrypted_credentials: string }>(`SELECT so.organization_id,so.site_id,s.url,so.gsc_property,oc.encrypted_credentials FROM site_onboarding so JOIN sites s ON s.id=so.site_id JOIN organization_connectors oc ON oc.organization_id=so.organization_id AND oc.provider='google-search-console' WHERE so.gsc_property IS NOT NULL AND oc.status='connected' AND oc.encrypted_credentials IS NOT NULL`);
  const results = [];
  for (const row of rows.rows) {
    const credential = JSON.parse(decryptCredential(row.encrypted_credentials)) as { refreshToken: string };
    const token = await new GoogleOAuthTokenProvider({ clientId, clientSecret, refreshToken: credential.refreshToken }).getAccessToken();
    const gsc = new GoogleSearchConsoleClient({ accessToken: token });
    const ledger = new PostgresChangeLedger(runtime.pool, siteIdForUrl(row.url));
    results.push(await runMeasurementSchedule({ ledger, recrawls: { lastCrawledAt: (url) => gsc.lastCrawledAt(row.gsc_property, url) }, metrics: { observedBaseline: async (change: ChangeRecord): Promise<MetricBaseline | null> => {
      const window = completedSearchWindow(); const metrics = await gsc.fetchPageMetrics(row.gsc_property, window); const selected = metrics.filter((metric) => change.affectedUrls.includes(metric.url));
      if (!selected.length) return null; const impressions = selected.reduce((sum, value) => sum + value.impressions, 0), clicks = selected.reduce((sum, value) => sum + value.clicks, 0);
      return { ...window, impressions, clicks, ctr: impressions ? clicks / impressions : 0, position: impressions ? selected.reduce((sum, value) => sum + value.position * value.impressions, 0) / impressions : 0, conversions: selected.reduce((sum, value) => sum + value.conversions, 0), conversionValue: selected.reduce((sum, value) => sum + value.conversionValue, 0), indexed: true };
    } } }));
  }
  return { sites: rows.rowCount, recrawled: results.flatMap((result) => result.recrawled).length, evaluated: results.flatMap((result) => result.evaluated).length };
}
