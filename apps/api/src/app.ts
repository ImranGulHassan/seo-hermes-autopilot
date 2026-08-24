import { Hono } from "hono";
import { calculatePilotScorecard, ChangeWorkflow, type ChangeLedger, type Opportunity, type ScanArtifact } from "@seo-autopilot/core";
import { handleGitHubWebhook, type WebhookDeliveryStore } from "@seo-autopilot/connectors";
import { z } from "zod";
import type { PostHog } from "posthog-node";

const artifactEnvelopeSchema = z.object({
  schemaVersion: z.literal(1), runId: z.string().startsWith("run_"), startedAt: z.string().datetime(), completedAt: z.string().datetime(),
  siteUrl: z.string().url(), dataState: z.enum(["technical-only", "search-performance", "analytics-enriched"]), pages: z.array(z.unknown()), metrics: z.array(z.unknown()), queryMetrics: z.array(z.unknown()).optional(), detectorDiagnostics: z.array(z.unknown()).optional(), errors: z.array(z.unknown()), opportunities: z.array(z.unknown())
});

export interface ApiStores {
  changes: ChangeLedger;
  deliveries: WebhookDeliveryStore;
  listSites(organizationId: string): Promise<Array<{ id: string; url: string; lastRunAt: string | null }>>;
  listChanges(organizationId: string, siteId?: string): Promise<Awaited<ReturnType<ChangeLedger["list"]>>>;
  listOpportunities(organizationId: string, siteId?: string): Promise<Opportunity[]>;
  listRecentRuns(organizationId: string, limit?: number, siteId?: string): Promise<ScanArtifact[]>;
  saveRun(organizationId: string, artifact: ScanArtifact): Promise<void>;
}

export function createApp(options: { stores: ApiStores; apiSecret: string; githubWebhookSecret: string; posthog?: PostHog | null }) {
  if (!options.apiSecret || !options.githubWebhookSecret) throw new Error("API and GitHub webhook secrets are required.");
  const app = new Hono();
  app.get("/health", (context) => context.json({ status: "ok" }));
  app.use("/v1/*", async (context, next) => {
    if (context.req.header("authorization") !== `Bearer ${options.apiSecret}`) return context.json({ error: "unauthorized" }, 401);
    if (!context.req.header("x-organization-id")) return context.json({ error: "organization_required" }, 400);
    await next();
  });
  const organizationId = (context: { req: { header(name: string): string | undefined } }) => context.req.header("x-organization-id")!;
  app.get("/v1/opportunities", async (context) => context.json({ opportunities: await options.stores.listOpportunities(organizationId(context), context.req.query("siteId")) }));
  app.get("/v1/sites", async (context) => context.json({ sites: await options.stores.listSites(organizationId(context)) }));
  app.get("/v1/changes", async (context) => context.json({ changes: await options.stores.listChanges(organizationId(context), context.req.query("siteId")) }));
  app.get("/v1/pilot-scorecard", async (context) => context.json({ scorecard: calculatePilotScorecard(await options.stores.listChanges(organizationId(context), context.req.query("siteId"))) }));
  app.get("/v1/dashboard", async (context) => {
    const orgId = organizationId(context);
    const sites = await options.stores.listSites(orgId);
    const requestedSiteId = context.req.query("siteId");
    if (requestedSiteId && !sites.some((site) => site.id === requestedSiteId)) return context.json({ error: "site_not_found" }, 404);
    const siteId = requestedSiteId ?? sites[0]?.id;
    const [runs, changes] = await Promise.all([options.stores.listRecentRuns(orgId, 30, siteId), options.stores.listChanges(orgId, siteId)]);
    return context.json({ ...buildDashboard(runs, changes), siteId: siteId ?? null, sites });
  });
  app.get("/v1/changes/:id", async (context) => {
    const change = (await options.stores.listChanges(organizationId(context))).find((item) => item.id === context.req.param("id"));
    return change ? context.json({ change }) : context.json({ error: "not_found" }, 404);
  });
  app.post("/v1/runs", async (context) => {
    const parsed = artifactEnvelopeSchema.safeParse(await context.req.json());
    if (!parsed.success) return context.json({ error: "invalid_scan_artifact", issues: parsed.error.issues }, 400);
    await options.stores.saveRun(organizationId(context), parsed.data as ScanArtifact);
    options.posthog?.capture({
      event: "scan_artifact_received",
      properties: {
        $process_person_profile: false,
        data_state: parsed.data.dataState,
        page_count: parsed.data.pages.length,
        metric_count: parsed.data.metrics.length,
        opportunity_count: parsed.data.opportunities.length,
        error_count: parsed.data.errors.length,
      },
    });
    await options.posthog?.flush();
    return context.json({ runId: parsed.data.runId }, 201);
  });
  app.onError(async (error, context) => {
    options.posthog?.captureException(error, undefined, {
      $request_method: context.req.method,
      $request_path: new URL(context.req.url).pathname,
    });
    await options.posthog?.flush();
    return context.json({ error: "internal_server_error" }, 500);
  });
  app.post("/webhooks/github", async (context) => {
    const rawBody = new Uint8Array(await context.req.arrayBuffer());
    try {
      const result = await handleGitHubWebhook({
        event: context.req.header("x-github-event") ?? "",
        deliveryId: context.req.header("x-github-delivery") ?? "",
        signature: context.req.header("x-hub-signature-256") ?? null,
        rawBody,
        secret: options.githubWebhookSecret,
        ledger: options.stores.changes,
        workflow: new ChangeWorkflow(options.stores.changes),
        deliveries: options.stores.deliveries
      });
      options.posthog?.capture({
        event: "github_webhook_processed",
        properties: {
          $process_person_profile: false,
          github_event: context.req.header("x-github-event") ?? "unknown",
        },
      });
      await options.posthog?.flush();
      return context.json(result);
    } catch (error) {
      return context.json({ error: error instanceof Error ? error.message : "webhook_failed" }, 401);
    }
  });
  return app;
}

function buildDashboard(runs: ScanArtifact[], changes: Awaited<ReturnType<ChangeLedger["list"]>>) {
  const latest = runs[0];
  const previous = runs.slice(1).find((run) => comparableWindows(latest, run));
  const metrics = latest?.metrics ?? [];
  const queries = [...(latest?.queryMetrics ?? [])].sort((a, b) => b.impressions - a.impressions);
  const impressions = metrics.reduce((sum, row) => sum + row.impressions, 0);
  const clicks = metrics.reduce((sum, row) => sum + row.clicks, 0);
  const weightedPosition = impressions ? metrics.reduce((sum, row) => sum + row.position * row.impressions, 0) / impressions : 0;
  const pages = latest?.pages ?? [];
  const opportunities = latest?.opportunities ?? [];
  const byType = Object.fromEntries(["broken-link", "metadata", "under-linked", "ctr-anomaly", "indexability-conflict"].map((type) => [type, opportunities.filter((item) => item.type === type).length]));
  const previousMetrics = new Map((previous?.metrics ?? []).map((metric) => [metric.url, metric]));
  const pageMovements = metrics.flatMap((metric) => {
    const prior = previousMetrics.get(metric.url);
    if (!prior) return [];
    return [{ url: metric.url, impressions: metric.impressions, clicks: metric.clicks, ctr: metric.ctr, position: metric.position, impressionDelta: metric.impressions - prior.impressions, clickDelta: metric.clicks - prior.clicks, ctrDelta: metric.ctr - prior.ctr, positionDelta: metric.position - prior.position }];
  });
  const siteCtr = impressions ? clicks / impressions : 0;
  const lowCtrPages = [...metrics].filter((metric) => metric.impressions >= 10 && metric.ctr < siteCtr).sort((a, b) => (siteCtr - b.ctr) * b.impressions - (siteCtr - a.ctr) * a.impressions).slice(0, 10);
  const freshnessHours = latest ? Math.max(0, (Date.now() - new Date(latest.completedAt).getTime()) / 3_600_000) : null;
  return {
    generatedAt: new Date().toISOString(),
    siteUrl: latest?.siteUrl ?? null,
    window: latest?.metricWindow ?? null,
    search: { impressions, clicks, ctr: impressions ? clicks / impressions : 0, position: weightedPosition, conversions: metrics.reduce((sum, row) => sum + row.conversions, 0), conversionValue: metrics.reduce((sum, row) => sum + row.conversionValue, 0), analyticsState: latest?.analyticsState ?? "not-configured", queryCount: queries.length, pageCount: metrics.length },
    health: { crawled: pages.length, live: pages.filter((page) => page.status >= 200 && page.status < 300).length, redirects: pages.filter((page) => page.status >= 300 && page.status < 400).length, broken: pages.filter((page) => page.status >= 400).length, indexable: pages.filter((page) => page.indexable).length, sitemapListed: pages.filter((page) => page.sitemapListed).length, errors: latest?.errors.length ?? 0 },
    opportunities: { total: opportunities.length, byType, items: opportunities.slice(0, 8), diagnostics: latest?.detectorDiagnostics ?? [] },
    topQueries: queries.slice(0, 12),
    topPages: [...metrics].sort((a, b) => b.impressions - a.impressions).slice(0, 10),
    performance: {
      comparison: previous ? { available: true, currentWindow: latest!.metricWindow, previousWindow: previous.metricWindow } : { available: false, reason: latest ? "No distinct, equal-length prior GSC window has been persisted yet." : "No completed scan is available." },
      winningPages: [...pageMovements].filter((row) => row.clickDelta > 0).sort((a, b) => b.clickDelta - a.clickDelta).slice(0, 10),
      decliningPages: [...pageMovements].filter((row) => row.clickDelta < 0).sort((a, b) => a.clickDelta - b.clickDelta).slice(0, 10),
      lowCtrPages,
      siteCtr
    },
    freshness: { completedAt: latest?.completedAt ?? null, ageHours: freshnessHours, state: freshnessHours === null ? "missing" : freshnessHours <= 36 ? "fresh" : freshnessHours <= 168 ? "aging" : "stale" },
    connectors: {
      searchConsole: { state: latest?.dataState === "technical-only" || !latest ? "unavailable" : latest.errors.some((error) => error.source === "gsc") ? "degraded" : "healthy", message: latest?.errors.find((error) => error.source === "gsc")?.message ?? (latest?.metricWindow ? `Data window ${latest.metricWindow.startDate} to ${latest.metricWindow.endDate}` : "No Search Console data window") },
      conversions: { state: latest?.analyticsState === "enriched" ? "healthy" : latest?.analyticsState === "unavailable" ? "degraded" : "not-configured", message: latest?.errors.find((error) => error.source === "posthog")?.message ?? (latest?.analyticsState === "enriched" ? "Conversion data enriched" : "Conversion tracking is not configured") }
    },
    history: [...runs].reverse().map((run) => { const runImpressions = run.metrics.reduce((sum, row) => sum + row.impressions, 0); const runClicks = run.metrics.reduce((sum, row) => sum + row.clicks, 0); return { completedAt: run.completedAt, impressions: runImpressions, clicks: runClicks, ctr: runImpressions ? runClicks / runImpressions : 0, pages: run.pages.length, opportunities: run.opportunities.length, errors: run.errors.length }; }),
    scorecard: calculatePilotScorecard(changes),
    changes: changes.slice(0, 8)
  };
}

function comparableWindows(current: ScanArtifact | undefined, candidate: ScanArtifact): boolean {
  if (!current?.metricWindow || !candidate.metricWindow) return false;
  if (current.metricWindow.startDate === candidate.metricWindow.startDate && current.metricWindow.endDate === candidate.metricWindow.endDate) return false;
  const days = (window: { startDate: string; endDate: string }) => new Date(window.endDate).getTime() - new Date(window.startDate).getTime();
  return days(current.metricWindow) === days(candidate.metricWindow);
}
