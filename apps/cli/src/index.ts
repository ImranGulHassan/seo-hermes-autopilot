import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { GitHubAppAuthenticator, GitHubAppClient, GoogleOAuthTokenProvider, GoogleSearchConsoleClient, PostHogConversionClient, completedSearchWindow, enrichWithConversions } from "@seo-autopilot/connectors";
import { ChangeWorkflow, InMemoryChangeLedger, createPullRequestProposal, crawlSite, normalizeUrl, pageSnapshotSchema, runDetectors, searchMetricSchema, stableId, workspaceConfigSchema, type ChangeLedger, type MetricBaseline, type Opportunity, type ScanArtifact, type WorkspaceConfig } from "@seo-autopilot/core";
import { PostgresChangeLedger, PostgresRunStore, createPool, migrate } from "@seo-autopilot/database";
import { discoverSourcePages, inspectGitFileStates, planRepositoryLinkPatches, validatePatchPlan, type SourcePage } from "@seo-autopilot/site-adapters";
import { z } from "zod";

const fileInputSchema = z.object({
  pages: z.array(pageSnapshotSchema),
  metrics: z.array(searchMetricSchema),
  sitemapUrls: z.array(z.string().url()).optional()
});

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const invocationRoot = process.env.INIT_CWD ?? process.cwd();
  const full = args.includes("--full");
  const live = args.includes("--live");
  const positional = args.filter((argument) => !["--full", "--live"].includes(argument));
  const [command, value, metricsPath] = positional;
  if (command === "repo-pages" && value && metricsPath) {
    const pages = await discoverSourcePages({ rootDir: resolve(invocationRoot, value), baseUrl: metricsPath });
    console.log(JSON.stringify({ pages, supportedPages: pages.length }, null, 2));
    return;
  }
  if (command === "init" && value) {
    const configPath = resolve(invocationRoot, metricsPath ?? ".seo-autopilot/workspace.json");
    const config = workspaceConfigSchema.parse({ version: 1, siteUrl: value });
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { flag: "wx" });
    console.log(`Created ${configPath}`);
    return;
  }
  if (command === "workspace") {
    const configPath = resolve(invocationRoot, value ?? ".seo-autopilot/workspace.json");
    const config = workspaceConfigSchema.parse(JSON.parse(await readFile(configPath, "utf8")));
    const artifact = await runWorkspace(config);
    const artifactPath = await saveArtifact(dirname(configPath), artifact);
    printResult(artifact.pages, artifact.errors, artifact.opportunities, full, artifactPath, artifact.dataState);
    return;
  }
  if (command === "orchestrate") {
    const configPath = resolve(invocationRoot, value ?? ".seo-autopilot/workspace.json");
    const artifactPath = metricsPath ? resolve(invocationRoot, metricsPath) : resolve(dirname(configPath), "latest.json");
    const config = workspaceConfigSchema.parse(JSON.parse(await readFile(configPath, "utf8")));
    const artifact = JSON.parse(await readFile(artifactPath, "utf8")) as ScanArtifact;
    console.log(JSON.stringify(await orchestrate(config, artifact, live), null, 2));
    return;
  }
  if (command === "from-file" && value) {
    const input = fileInputSchema.parse(JSON.parse(await readFile(resolve(invocationRoot, value), "utf8")));
    const scanInput = input.sitemapUrls
      ? { pages: input.pages, metrics: input.metrics, sitemapUrls: input.sitemapUrls }
      : { pages: input.pages, metrics: input.metrics };
    console.log(JSON.stringify({ opportunities: runDetectors(scanInput) }, null, 2));
    return;
  }
  if (command === "crawl" && value) {
    const metrics = metricsPath ? z.array(searchMetricSchema).parse(JSON.parse(await readFile(resolve(invocationRoot, metricsPath), "utf8"))) : [];
    const result = await crawlSite(value);
    const opportunities = runDetectors({ pages: result.pages, metrics, sitemapUrls: result.sitemapUrls });
    printResult(result.pages, result.errors.map((error) => ({ source: "crawler" as const, message: error.error, url: error.url })), opportunities, full);
    return;
  }
  console.error("Usage:\n  pnpm scan init <https://site.example> [config.json]\n  pnpm scan workspace [config.json] [--full]\n  pnpm scan orchestrate [config.json] [artifact.json] [--live]\n  pnpm scan repo-pages <repository-root> <https://site.example>\n  pnpm scan from-file <scan.json>\n  pnpm scan crawl <https://site.example> [metrics.json] [--full]");
  process.exitCode = 1;
}

async function runWorkspace(config: WorkspaceConfig): Promise<ScanArtifact> {
  const startedAt = new Date();
  const repositoryErrors: ScanArtifact["errors"] = [];
  let sources: SourcePage[] = [];
  if (config.repository) {
    try {
      sources = await discoverSourcePages({ rootDir: config.repository.rootDir, baseUrl: config.siteUrl, contentRoots: config.repository.contentRoots, protectedPaths: config.protectedPaths });
    } catch (error) {
      repositoryErrors.push({ source: "repository", message: error instanceof Error ? error.message : String(error) });
    }
  }
  const crawl = await crawlSite(config.siteUrl, { ...config.crawl, seedUrls: sources.map((source) => source.url) });
  const errors: ScanArtifact["errors"] = [...crawl.errors.map((error) => ({ source: "crawler" as const, message: error.error, url: error.url })), ...repositoryErrors];
  const sourceByUrl = new Map(sources.map((source) => [normalizeUrl(source.url), source.filePath]));
  const sourceStates = config.repository && sources.length > 0 ? await inspectGitFileStates(config.repository.rootDir, sources.map((source) => source.filePath)) : new Map();
  for (const page of crawl.pages) {
    page.sourcePath = sourceByUrl.get(normalizeUrl(page.url)) ?? null;
    if (page.sourcePath) page.sourceState = sourceStates.get(page.sourcePath) ?? null;
  }
  let metrics: ScanArtifact["metrics"] = [];
  let queryMetrics: NonNullable<ScanArtifact["queryMetrics"]> = [];
  const metricWindow = completedSearchWindow();
  if (config.gscPropertyUrl) {
    try {
      const accessToken = await googleAccessToken();
      if (!accessToken) {
        errors.push({ source: "gsc", message: "GSC_ACCESS_TOKEN is not set; completed a technical-only run." });
      } else {
        const gsc = new GoogleSearchConsoleClient({ accessToken });
        [metrics, queryMetrics] = await Promise.all([gsc.fetchPageMetrics(config.gscPropertyUrl, metricWindow), gsc.fetchQueryMetrics(config.gscPropertyUrl, metricWindow)]);
      }
    } catch (error) {
      errors.push({ source: "gsc", message: error instanceof Error ? error.message : String(error) });
    }
  }
  let analyticsState: ScanArtifact["analyticsState"] = config.posthog ? "unavailable" : "not-configured";
  if (config.posthog && metrics.length > 0) {
    const personalApiKey = process.env.POSTHOG_PERSONAL_API_KEY?.trim();
    const projectId = process.env.POSTHOG_PROJECT_ID?.trim();
    if (!personalApiKey || !projectId) {
      errors.push({ source: "posthog", message: "POSTHOG_PERSONAL_API_KEY or POSTHOG_PROJECT_ID is not set; retained search-only metrics." });
    } else {
      try {
        const host = process.env.POSTHOG_API_HOST?.trim();
        const posthog = new PostHogConversionClient({ personalApiKey, projectId, ...(host ? { host } : {}) });
        const conversions = await posthog.fetchLandingPageConversions(metricWindow, config.posthog.eventName, config.posthog.revenueProperty);
        metrics = enrichWithConversions(metrics, conversions);
        analyticsState = "enriched";
      } catch (error) {
        errors.push({ source: "posthog", message: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  const completedAt = new Date();
  return {
    schemaVersion: 1,
    runId: `run_${stableId([config.siteUrl, startedAt.toISOString()])}`,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    siteUrl: config.siteUrl,
    dataState: metrics.length > 0 ? (analyticsState === "enriched" ? "analytics-enriched" : "search-performance") : "technical-only",
    analyticsState,
    ...(metrics.length > 0 ? { metricWindow } : {}),
    pages: crawl.pages,
    metrics,
    queryMetrics,
    sitemapUrls: crawl.sitemapUrls,
    errors,
    opportunities: runDetectors({ pages: crawl.pages, metrics, sitemapUrls: crawl.sitemapUrls })
  };
}

async function googleAccessToken(): Promise<string | undefined> {
  const { GOOGLE_CLIENT_ID: clientId, GOOGLE_CLIENT_SECRET: clientSecret, GOOGLE_REFRESH_TOKEN: refreshToken } = process.env;
  if (clientId && clientSecret && refreshToken) return new GoogleOAuthTokenProvider({ clientId, clientSecret, refreshToken }).getAccessToken();
  return process.env.GSC_ACCESS_TOKEN?.trim() || undefined;
}

interface OrchestrationItem { opportunityId: string; status: "ready" | "opened" | "skipped" | "failed"; reason?: string; file?: string; pullRequestUrl?: string }

async function orchestrate(config: WorkspaceConfig, artifact: ScanArtifact, live: boolean): Promise<{ mode: "dry-run" | "live"; items: OrchestrationItem[] }> {
  if (!config.repository) throw new Error("repository configuration is required for orchestration.");
  if (live && !config.github) throw new Error("github configuration is required with --live.");
  const repairGroups = new Map<string, Opportunity[]>();
  const mappings = reviewedDestinationMappings(config, artifact);
  for (const opportunity of artifact.opportunities.filter((item) => item.type === "broken-link")) {
    const target = String(opportunity.evidence.target);
    const mapped = mappings.get(normalizeUrl(new URL(target, config.siteUrl).toString()));
    const destination = typeof opportunity.evidence.redirectTarget === "string" ? opportunity.evidence.redirectTarget : mapped?.to;
    if (!destination) continue;
    const repair = mapped ? { ...opportunity, evidence: { ...opportunity.evidence, redirectTarget: destination, resolutionSource: "reviewed-destination-mapping", mappingApproval: { approvedBy: mapped.approvedBy, approvedAt: mapped.approvedAt, ...(mapped.note ? { note: mapped.note } : {}) } } } : opportunity;
    const key = `${target}\n${destination}`;
    repairGroups.set(key, [...(repairGroups.get(key) ?? []), repair]);
  }
  const selectedGroups = [...repairGroups.values()].slice(0, config.orchestration.maxChanges);
  const candidates = selectedGroups.map(groupRedirectOpportunities);
  const handledIds = new Set(selectedGroups.flat().map((opportunity) => opportunity.id));
  const items: OrchestrationItem[] = [];
  let pool: ReturnType<typeof createPool> | undefined;
  let ledger: ChangeLedger = new InMemoryChangeLedger();
  let github: GitHubAppClient | undefined;
  if (live) {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required with --live.");
    pool = createPool({ connectionString: process.env.DATABASE_URL });
    await migrate(pool);
    await new PostgresRunStore(pool).save(artifact);
    ledger = new PostgresChangeLedger(pool);
    const keyPath = process.env.GITHUB_PRIVATE_KEY_PATH;
    if (!process.env.GITHUB_APP_ID || !process.env.GITHUB_INSTALLATION_ID || !keyPath) throw new Error("GITHUB_APP_ID, GITHUB_INSTALLATION_ID, and GITHUB_PRIVATE_KEY_PATH are required with --live.");
    const privateKey = await readFile(keyPath, "utf8");
    github = new GitHubAppClient({ tokenProvider: new GitHubAppAuthenticator({ appId: process.env.GITHUB_APP_ID, installationId: process.env.GITHUB_INSTALLATION_ID, privateKey }) });
  }
  try {
    const workflow = new ChangeWorkflow(ledger);
    for (const opportunity of candidates) {
      try {
        const patches = await planRepositoryLinkPatches(config.repository.rootDir, String(opportunity.evidence.target), String(opportunity.evidence.redirectTarget), ["src", ...config.repository.contentRoots]);
        if (patches.length === 0) { items.push({ opportunityId: opportunity.id, status: "skipped", reason: "No structured source link matches the rendered redirect." }); continue; }
        const states = await inspectGitFileStates(config.repository.rootDir, patches.map((patch) => patch.filePath));
        const ineligible = patches.filter((patch) => states.get(patch.filePath) !== "tracked-clean");
        if (ineligible.length > 0) {
          items.push({ opportunityId: opportunity.id, status: "skipped", file: ineligible.map((patch) => patch.filePath).join(", "), reason: `PR blocked: source must be tracked and clean (${ineligible.map((patch) => `${patch.filePath}: ${states.get(patch.filePath)}`).join("; ")}).` });
          continue;
        }
        const validations = await validatePatchPlan({ rootDir: config.repository.rootDir, patches, protectedPaths: config.protectedPaths, validators: config.repository.validators });
        const failed = validations.find((validation) => !validation.passed);
        const fileSummary = patches.map((patch) => patch.filePath).join(", ");
        if (failed) { items.push({ opportunityId: opportunity.id, status: "failed", file: fileSummary, reason: `${failed.name}: ${failed.details}` }); continue; }
        const proposal = createPullRequestProposal(opportunity, validations);
        if (!live) { items.push({ opportunityId: opportunity.id, status: "ready", file: fileSummary, reason: `${proposal.title} (${patches.length} files)` }); continue; }
        const prior = await ledger.findByFingerprint(opportunity.fingerprint);
        const change = prior?.state === "proposed" && !prior.externalPullRequest
          ? prior
          : await workflow.propose({ opportunity, baseline: baselineFor(artifact, opportunity), changedPaths: patches.map((patch) => patch.filePath), protectedPaths: config.protectedPaths });
        const target = config.github!;
        const pr = await github!.createDraftPullRequest({ owner: target.owner, repository: target.repository, baseBranch: target.baseBranch, headBranch: proposal.branch, title: proposal.title, body: proposal.body, commitMessage: proposal.title, files: patches.map((patch) => ({ filePath: patch.filePath, beforeContent: patch.before, content: patch.after })) });
        await workflow.recordPullRequest(change.id, { provider: "github", owner: target.owner, repository: target.repository, number: pr.number, nodeId: pr.nodeId, headBranch: pr.headBranch }, pr.url);
        items.push({ opportunityId: opportunity.id, status: "opened", file: fileSummary, pullRequestUrl: pr.url });
      } catch (error) { items.push({ opportunityId: opportunity.id, status: "failed", reason: error instanceof Error ? error.message : String(error) }); }
    }
    for (const opportunity of artifact.opportunities.filter((item) => !handledIds.has(item.id))) items.push({ opportunityId: opportunity.id, status: "skipped", reason: "Proposal-only or no deterministic replacement is available." });
    return { mode: live ? "live" : "dry-run", items };
  } finally { await pool?.end(); }
}

function reviewedDestinationMappings(config: WorkspaceConfig, artifact: ScanArtifact): Map<string, { to: string; approvedBy: string; approvedAt: string; note?: string }> {
  const siteOrigin = new URL(config.siteUrl).origin;
  const livePages = new Set(artifact.pages.filter((page) => page.status >= 200 && page.status < 300).map((page) => normalizeUrl(page.url)));
  const mappings = new Map<string, { to: string; approvedBy: string; approvedAt: string; note?: string }>();
  for (const mapping of config.orchestration.destinationMappings) {
    const from = normalizeUrl(new URL(mapping.from, config.siteUrl).toString());
    const to = normalizeUrl(new URL(mapping.to, config.siteUrl).toString());
    if (new URL(from).origin !== siteOrigin || new URL(to).origin !== siteOrigin) throw new Error(`Destination mapping must remain on ${siteOrigin}: ${mapping.from} -> ${mapping.to}`);
    if (from === to) throw new Error(`Destination mapping cannot map a URL to itself: ${mapping.from}`);
    if (!livePages.has(to)) throw new Error(`Reviewed destination did not return 2xx in this scan: ${mapping.to}`);
    if (mappings.has(from)) throw new Error(`Duplicate destination mapping for ${mapping.from}`);
    mappings.set(from, { to, approvedBy: mapping.approvedBy, approvedAt: mapping.approvedAt, ...(mapping.note ? { note: mapping.note } : {}) });
  }
  return mappings;
}

function groupRedirectOpportunities(group: Opportunity[]): Opportunity {
  const first = group[0]!;
  const target = String(first.evidence.target);
  const redirectTarget = String(first.evidence.redirectTarget);
  const fingerprint = stableId(["redirect-group", target, redirectTarget]);
  return {
    ...first,
    id: `opp_${fingerprint}`,
    fingerprint,
    title: group.length > 1 ? `Remove ${group.length} internal redirect hops` : first.title,
    affectedUrls: [...new Set(group.flatMap((item) => item.affectedUrls))],
    estimatedValue: group.reduce((sum, item) => sum + item.estimatedValue, 0),
    evidence: { target, redirectTarget, occurrences: group.length, sourcePages: group.map((item) => item.evidence.source), opportunityIds: group.map((item) => item.id) }
  };
}

function baselineFor(artifact: ScanArtifact, opportunity: Opportunity): MetricBaseline {
  const affected = new Set(opportunity.affectedUrls.map(normalizeUrl));
  const metrics = artifact.metrics.filter((metric) => affected.has(normalizeUrl(metric.url)));
  const impressions = metrics.reduce((sum, metric) => sum + metric.impressions, 0);
  const clicks = metrics.reduce((sum, metric) => sum + metric.clicks, 0);
  const window = artifact.metricWindow ?? { startDate: artifact.startedAt.slice(0, 10), endDate: artifact.completedAt.slice(0, 10) };
  return { ...window, impressions, clicks, ctr: impressions ? clicks / impressions : 0, position: metrics.length ? metrics.reduce((sum, metric) => sum + metric.position, 0) / metrics.length : 0, conversions: metrics.reduce((sum, metric) => sum + metric.conversions, 0), conversionValue: metrics.reduce((sum, metric) => sum + metric.conversionValue, 0), indexed: artifact.pages.filter((page) => affected.has(normalizeUrl(page.url))).every((page) => page.indexable) };
}

async function saveArtifact(workspaceDirectory: string, artifact: ScanArtifact): Promise<string> {
  const runsDirectory = resolve(workspaceDirectory, "runs");
  await mkdir(runsDirectory, { recursive: true });
  const filename = `${artifact.startedAt.replace(/[:.]/g, "-")}-${artifact.runId}.json`;
  const artifactPath = resolve(runsDirectory, filename);
  const serialized = `${JSON.stringify(artifact, null, 2)}\n`;
  await writeFile(artifactPath, serialized, { flag: "wx" });
  const latestPath = resolve(workspaceDirectory, "latest.json");
  const temporaryLatest = `${latestPath}.${process.pid}.tmp`;
  await writeFile(temporaryLatest, serialized);
  await rename(temporaryLatest, latestPath);
  return artifactPath;
}

function printResult(
  pages: ScanArtifact["pages"],
  errors: ScanArtifact["errors"],
  opportunities: ScanArtifact["opportunities"],
  full: boolean,
  artifactPath?: string,
  dataState?: ScanArtifact["dataState"]
): void {
  const statuses = Object.fromEntries([...new Set(pages.map((page) => page.status))].sort().map((status) => [String(status), pages.filter((page) => page.status === status).length]));
  console.log(JSON.stringify({
    summary: { pagesCrawled: pages.length, statuses, errors: errors.length, opportunities: opportunities.length, ...(dataState ? { dataState } : {}), ...(artifactPath ? { artifactPath } : {}) },
    errors,
    opportunities,
    ...(full ? { pages } : {})
  }, null, 2));
}

await main();
