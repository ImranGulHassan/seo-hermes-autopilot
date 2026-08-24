import { completedSearchWindow, enrichWithConversions, GoogleOAuthTokenProvider, GoogleSearchConsoleClient, PostHogConversionClient } from "@seo-autopilot/connectors";
import { analyzeDetectors, crawlSite, stableId, type ScanArtifact } from "@seo-autopilot/core";
import { createPool, migrate, PostgresRunStore, PostgresTenantStore } from "@seo-autopilot/database";
import { NextResponse } from "next/server";
import { currentSession, hasMinimumRole } from "../auth/session";
import type { StoredSession } from "../auth/types";
import { decryptCredential } from "./credentials";

function createRuntime() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required.");
  const pool = createPool({ connectionString: databaseUrl, max: 3 });
  return { pool, tenants: new PostgresTenantStore(pool), runs: new PostgresRunStore(pool), ready: migrate(pool) };
}

let singleton: ReturnType<typeof createRuntime> | undefined;
export async function onboardingRuntime() {
  singleton ??= createRuntime();
  await singleton.ready;
  return singleton;
}

export async function onboardingOwner(): Promise<StoredSession | NextResponse> {
  const session = await currentSession();
  if (!session) return NextResponse.json({ error: "Authentication required.", action: "Sign in again." }, { status: 401 });
  if (!hasMinimumRole(session.role, "owner")) return NextResponse.json({ error: "Owner access is required.", action: "Ask an organization owner to complete onboarding." }, { status: 403 });
  return session;
}

export function isResponse(value: StoredSession | NextResponse): value is NextResponse { return value instanceof NextResponse; }

export async function onboardingStatus(session: StoredSession, requestedSiteId?: string) {
  const runtime = await onboardingRuntime();
  const [sites, connectors, onboardingRows, organization] = await Promise.all([
    runtime.tenants.listSites(session.organizationId), runtime.tenants.listConnectors(session.organizationId),
    runtime.tenants.listSiteOnboarding(session.organizationId),
    runtime.pool.query<{ id: string; name: string; slug: string | null }>("SELECT id,name,slug FROM organizations WHERE id=$1", [session.organizationId])
  ]);
  const site = requestedSiteId ? sites.find((item) => item.id === requestedSiteId) : undefined;
  const onboarding = site ? onboardingRows.find((row) => row.siteId === site.id) : undefined;
  const connector = (provider: "github" | "google-search-console" | "posthog") => connectors.find((item) => item.provider === provider);
  const github = connector("github"), gsc = connector("google-search-console"), posthog = connector("posthog");
  const latest = site ? (await runtime.runs.listRecent(session.organizationId, 1, site.id))[0] : undefined;
  return {
    organization: { id: session.organizationId, name: organization.rows[0]?.name ?? session.organizationName, slug: organization.rows[0]?.slug ?? "" },
    sites: sites.map((item) => ({ id: item.id, name: new URL(item.url).hostname, url: item.url })),
    site: site ? { id: site.id, name: new URL(site.url).hostname, url: site.url } : null,
    github: { status: github?.status ?? "disconnected", repository: onboarding?.githubOwner && onboarding.githubRepository ? `${onboarding.githubOwner}/${onboarding.githubRepository}` : undefined, branch: onboarding?.githubBranch ?? "main", installUrl: process.env.GITHUB_APP_SLUG ? `https://github.com/apps/${process.env.GITHUB_APP_SLUG}/installations/new` : undefined, error: github?.errorMessage ?? undefined, action: github?.health.action },
    gsc: { status: gsc?.status ?? "disconnected", property: onboarding?.gscProperty ?? undefined, properties: Array.isArray(gsc?.health.properties) ? gsc.health.properties : [], error: gsc?.errorMessage ?? undefined, action: gsc?.health.action },
    posthog: { status: posthog?.health.skipped ? "skipped" : posthog?.status ?? "disconnected", projectId: onboarding?.posthogProjectId ?? undefined, host: posthog?.health.host, error: posthog?.errorMessage ?? undefined, action: posthog?.health.action },
    configuration: { branch: onboarding?.githubBranch ?? "main", protectedPaths: onboarding?.protectedPaths?.length ? onboarding.protectedPaths : ["app/api/**", "middleware.ts", "next.config.*"], saved: onboarding ? ["scan", "complete"].includes(onboarding.state) : false },
    scan: { state: onboarding?.scanState ?? "not-started", runId: onboarding?.scanRunId ?? undefined, pages: latest?.pages.length, opportunities: latest?.opportunities.length, error: onboarding?.errorMessage ?? undefined },
    nextStep: onboarding?.state ?? "organization"
  };
}

export async function runFirstScan(session: StoredSession, siteId: string): Promise<ScanArtifact> {
  const runtime = await onboardingRuntime();
  const site = await runtime.tenants.getSite(session.organizationId, siteId);
  const onboarding = await runtime.tenants.getSiteOnboarding(session.organizationId, siteId);
  if (!site || !onboarding) throw new Error("Complete the site configuration before starting a scan.");
  const startedAt = new Date();
  const crawl = await crawlSite(site.url, { maxPages: 100, concurrency: 8, maxTransientRetries: 1 });
  const errors: ScanArtifact["errors"] = crawl.errors.map((item) => ({ source: "crawler", message: item.error, url: item.url }));
  let metrics: ScanArtifact["metrics"] = [], queryMetrics: NonNullable<ScanArtifact["queryMetrics"]> = [];
  const metricWindow = completedSearchWindow();
  const google = await runtime.tenants.getConnector(session.organizationId, "google-search-console");
  if (google?.status === "connected" && google.encryptedCredentials && onboarding.gscProperty) {
    try {
      const credential = JSON.parse(decryptCredential(google.encryptedCredentials)) as { refreshToken: string };
      const clientId = process.env.GOOGLE_CLIENT_ID, clientSecret = process.env.GOOGLE_CLIENT_SECRET;
      if (!clientId || !clientSecret) throw new Error("Google OAuth application credentials are not configured.");
      const accessToken = await new GoogleOAuthTokenProvider({ clientId, clientSecret, refreshToken: credential.refreshToken }).getAccessToken();
      const gsc = new GoogleSearchConsoleClient({ accessToken });
      [metrics, queryMetrics] = await Promise.all([gsc.fetchPageMetrics(onboarding.gscProperty, metricWindow), gsc.fetchQueryMetrics(onboarding.gscProperty, metricWindow)]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push({ source: "gsc", message });
      await runtime.tenants.upsertConnector({ organizationId: session.organizationId, provider: "google-search-console", status: "error", errorCode: "scan-verification-failed", errorMessage: message, health: { action: "Reconnect Search Console, then retry the scan." } });
    }
  }
  let analyticsState: ScanArtifact["analyticsState"] = "not-configured";
  const posthog = await runtime.tenants.getConnector(session.organizationId, "posthog");
  if (posthog?.status === "connected" && posthog.encryptedCredentials && metrics.length) {
    try {
      const credential = JSON.parse(decryptCredential(posthog.encryptedCredentials)) as { apiKey: string; host: string; eventName: string; revenueProperty: string };
      const client = new PostHogConversionClient({ personalApiKey: credential.apiKey, projectId: onboarding.posthogProjectId!, host: credential.host });
      metrics = enrichWithConversions(metrics, await client.fetchLandingPageConversions(metricWindow, credential.eventName, credential.revenueProperty));
      analyticsState = "enriched";
    } catch (error) {
      analyticsState = "unavailable";
      const message = error instanceof Error ? error.message : String(error);
      errors.push({ source: "posthog", message });
      await runtime.tenants.upsertConnector({ organizationId: session.organizationId, provider: "posthog", status: "error", errorCode: "scan-verification-failed", errorMessage: message, health: { action: "Verify the PostHog project, event, and API key, then retry." } });
    }
  }
  const detectorResult = analyzeDetectors({ pages: crawl.pages, metrics, sitemapUrls: crawl.sitemapUrls });
  const artifact: ScanArtifact = {
    schemaVersion: 1, runId: `run_${stableId([site.url, startedAt.toISOString()])}`, startedAt: startedAt.toISOString(), completedAt: new Date().toISOString(), siteUrl: site.url,
    dataState: metrics.length ? (analyticsState === "enriched" ? "analytics-enriched" : "search-performance") : "technical-only", analyticsState,
    ...(metrics.length ? { metricWindow } : {}), pages: crawl.pages, metrics, queryMetrics, sitemapUrls: crawl.sitemapUrls, errors,
    opportunities: detectorResult.opportunities, detectorDiagnostics: detectorResult.diagnostics
  };
  await runtime.runs.save(artifact, session.organizationId);
  return artifact;
}
