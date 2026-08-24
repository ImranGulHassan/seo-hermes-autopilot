import { ConnectorError, GitHubAppAuthenticator, verifyGitHubRepository, verifyPostHogConnection } from "@seo-autopilot/connectors";
import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { issueSession } from "../../../../../lib/auth/session";
import { isSameOrigin } from "../../../../../lib/auth/request";
import { encryptCredential } from "../../../../../lib/onboarding/credentials";
import { isResponse, onboardingOwner, onboardingRuntime, onboardingStatus, runFirstScan } from "../../../../../lib/onboarding/runtime";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request, context: { params: Promise<{ action: string }> }): Promise<Response> {
  if (!isSameOrigin(request)) return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  const session = await onboardingOwner();
  if (isResponse(session)) return session;
  const { action } = await context.params;
  const runtime = await onboardingRuntime();
  try {
    const body = await request.json() as Record<string, unknown>;
    let responseSiteId = typeof body.siteId === "string" ? body.siteId : undefined;
    if (action === "organization") {
      const name = text(body.name, "Organization name");
      const slug = optionalText(body.slug)?.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "") || null;
      if (body.createNew === true) {
        const organizationId = `org_${randomBytes(10).toString("hex")}`;
        await runtime.tenants.createOrganization({ id: organizationId, slug: slug ?? organizationId, name, ownerUserId: session.userId });
        session.organizationId = organizationId;
      } else await runtime.pool.query("UPDATE organizations SET name=$2,slug=COALESCE($3,slug) WHERE id=$1", [session.organizationId, name, slug]);
      session.organizationName = name;
      await issueSession(session);
    } else if (action === "site") {
      const url = new URL(text(body.url, "Production URL"));
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error("Production URL must use HTTP or HTTPS.");
      const site = await runtime.tenants.createSite({ organizationId: session.organizationId, url: url.origin });
      responseSiteId = site.id;
      await runtime.tenants.upsertSiteOnboarding({ organizationId: session.organizationId, siteId: site.id, state: "github" });
    } else if (action === "github") {
      const [owner, repository, extra] = text(body.repository, "GitHub repository").split("/");
      if (!owner || !repository || extra) throw new Error("Repository must use owner/name format.");
      const installationId = optionalText(body.installationId) ?? process.env.GITHUB_INSTALLATION_ID;
      const appId = process.env.GITHUB_APP_ID, privateKey = process.env.GITHUB_PRIVATE_KEY?.replace(/\\n/g, "\n");
      if (!installationId || !appId || !privateKey) throw new Error("GitHub App server credentials are not configured. Install the app and configure its App ID, installation ID, and private key.");
      const site = await selectedSite(runtime, session.organizationId, body.siteId);
      const branch = text(body.branch, "Repository branch");
      const verified = await verifyGitHubRepository({ installationId, owner, repository, branch, tokenProvider: new GitHubAppAuthenticator({ appId, installationId, privateKey }) });
      await runtime.tenants.upsertConnector({ organizationId: session.organizationId, provider: "github", status: "connected", externalAccountId: String(verified.installationId), health: { account: verified.installationAccount, canPull: verified.canPull, canPush: verified.canPush, branchProtected: verified.branchProtected } });
      await runtime.tenants.upsertSiteOnboarding({ organizationId: session.organizationId, siteId: site.id, state: "search-console", githubInstallationId: String(verified.installationId), githubOwner: owner, githubRepository: repository, githubBranch: verified.branch });
    } else if (action === "gsc-property") {
      const site = await selectedSite(runtime, session.organizationId, body.siteId);
      await requireConnected(runtime, session.organizationId, "google-search-console", "Connect Google Search Console before selecting a property.");
      const property = text(body.property, "Search Console property");
      const google = await runtime.tenants.getConnector(session.organizationId, "google-search-console");
      const properties = Array.isArray(google?.health.properties) ? google.health.properties as Array<{ siteUrl?: unknown }> : [];
      if (!properties.some((item) => item.siteUrl === property)) throw new Error("Select a Search Console property available to the connected Google account.");
      await runtime.tenants.upsertSiteOnboarding({ organizationId: session.organizationId, siteId: site.id, state: "analytics", gscProperty: property });
    } else if (action === "posthog") {
      const site = await selectedSite(runtime, session.organizationId, body.siteId);
      await requireConnected(runtime, session.organizationId, "google-search-console", "Connect Google Search Console before configuring conversions.");
      if (body.skip === true) {
        await runtime.tenants.upsertConnector({ organizationId: session.organizationId, provider: "posthog", status: "disconnected", health: { skipped: true } });
        await runtime.tenants.upsertSiteOnboarding({ organizationId: session.organizationId, siteId: site.id, state: "configuration" });
      } else {
        const host = optionalText(body.host) ?? "https://us.posthog.com", projectId = text(body.projectId, "PostHog project ID"), apiKey = text(body.apiKey, "PostHog API key");
        const eventName = optionalText(body.eventName) ?? "signup", revenueProperty = optionalText(body.revenueProperty) ?? "revenue";
        const verified = await verifyPostHogConnection({ host, projectId, personalApiKey: apiKey, eventName });
        await runtime.tenants.upsertConnector({ organizationId: session.organizationId, provider: "posthog", status: "connected", externalAccountId: projectId, encryptedCredentials: encryptCredential(JSON.stringify({ apiKey, host: verified.host, eventName, revenueProperty })), health: { host: verified.host, projectName: verified.projectName, eventName, eventSeen: verified.eventSeen } });
        await runtime.tenants.upsertSiteOnboarding({ organizationId: session.organizationId, siteId: site.id, state: "configuration", posthogProjectId: projectId });
      }
    } else if (action === "configuration") {
      const site = await selectedSite(runtime, session.organizationId, body.siteId), branch = text(body.branch, "Repository branch");
      await requireConnected(runtime, session.organizationId, "github", "Connect and verify GitHub before saving repository safety rules.");
      await requireConnected(runtime, session.organizationId, "google-search-console", "Connect Google Search Console before saving repository safety rules.");
      const analytics = await runtime.tenants.getConnector(session.organizationId, "posthog");
      if (!analytics || (analytics.status !== "connected" && analytics.health.skipped !== true)) throw new Error("Verify PostHog or explicitly skip conversions before saving repository safety rules.");
      const protectedPaths = Array.isArray(body.protectedPaths) ? body.protectedPaths.map((item) => String(item).trim()).filter(Boolean) : [];
      if (protectedPaths.length > 100 || protectedPaths.some((item) => item.startsWith("/") || item.includes("..") || item.length > 200)) throw new Error("Protected paths must be repository-relative patterns without '..'.");
      await runtime.tenants.upsertSiteOnboarding({ organizationId: session.organizationId, siteId: site.id, state: "scan", githubBranch: branch, protectedPaths });
    } else if (action === "scan") {
      const site = await selectedSite(runtime, session.organizationId, body.siteId);
      const configured = await runtime.tenants.getSiteOnboarding(session.organizationId, site.id);
      if (configured?.state !== "scan" && configured?.state !== "complete") throw new Error("Complete connectors and repository safety rules before starting the first scan.");
      await runtime.tenants.upsertSiteOnboarding({ organizationId: session.organizationId, siteId: site.id, scanState: "running", errorCode: null, errorMessage: null });
      try {
        const artifact = await runFirstScan(session, site.id);
        await runtime.tenants.upsertSiteOnboarding({ organizationId: session.organizationId, siteId: site.id, state: "complete", scanState: "complete", scanRunId: artifact.runId, errorCode: null, errorMessage: null });
      } catch (error) {
        await runtime.tenants.upsertSiteOnboarding({ organizationId: session.organizationId, siteId: site.id, scanState: "failed", errorCode: "scan-failed", errorMessage: error instanceof Error ? error.message : "The first scan failed." });
        throw error;
      }
    } else return NextResponse.json({ error: "Unknown onboarding action." }, { status: 404 });
    return Response.json(await onboardingStatus(session, responseSiteId));
  } catch (error) {
    const provider = action === "github" ? "github" : action === "posthog" ? "posthog" : undefined;
    if (provider) await runtime.tenants.upsertConnector({ organizationId: session.organizationId, provider, status: "error", errorCode: error instanceof ConnectorError ? error.code : "invalid-config", errorMessage: error instanceof Error ? error.message : "Connector verification failed.", health: { action: error instanceof ConnectorError ? error.action : "Review the connector settings and retry." } });
    return actionError(error);
  }
}

async function selectedSite(runtime: Awaited<ReturnType<typeof onboardingRuntime>>, organizationId: string, value: unknown) {
  const siteId = text(value, "Site");
  const site = await runtime.tenants.getSite(organizationId, siteId);
  if (!site) throw new Error("Select a site in this organization before configuring connectors.");
  return site;
}

async function requireConnected(runtime: Awaited<ReturnType<typeof onboardingRuntime>>, organizationId: string, provider: "github" | "google-search-console", message: string) {
  if ((await runtime.tenants.getConnector(organizationId, provider))?.status !== "connected") throw new Error(message);
}

function text(value: unknown, label: string): string { if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required.`); return value.trim(); }
function optionalText(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value.trim() : undefined; }
function actionError(error: unknown) {
  if (error instanceof ConnectorError) return NextResponse.json({ error: error.message, action: error.action, code: error.code }, { status: error.status && error.status < 500 ? 400 : 502 });
  return NextResponse.json({ error: error instanceof Error ? error.message : "Onboarding failed.", action: "Correct this step and retry; no partial site changes were published." }, { status: 400 });
}
