import { ConnectorError, exchangeGoogleOAuthCode, listSearchConsoleProperties, verifyGoogleOAuthState } from "@seo-autopilot/connectors";
import { NextResponse } from "next/server";
import { encryptCredential } from "../../../../../../lib/onboarding/credentials";
import { isResponse, onboardingOwner, onboardingRuntime } from "../../../../../../lib/onboarding/runtime";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const session = await onboardingOwner();
  if (isResponse(session)) return session;
  const url = new URL(request.url), code = url.searchParams.get("code"), rawState = url.searchParams.get("state");
  const clientId = process.env.GOOGLE_CLIENT_ID, clientSecret = process.env.GOOGLE_CLIENT_SECRET, secret = process.env.SESSION_SECRET;
  try {
    if (!code || !rawState || !clientId || !clientSecret || !secret) throw new Error("Google OAuth callback is missing required configuration or parameters.");
    const state = verifyGoogleOAuthState(rawState, secret);
    if (state.organizationId !== session.organizationId || state.userId !== session.userId) throw new Error("Google OAuth state does not match the signed-in organization.");
    const redirectUri = process.env.GOOGLE_REDIRECT_URI ?? `${url.origin}/api/v1/onboarding/google/callback`;
    const tokens = await exchangeGoogleOAuthCode({ clientId, clientSecret, code, redirectUri });
    const runtime = await onboardingRuntime(), properties = await listSearchConsoleProperties({ accessToken: tokens.access_token });
    const site = (await runtime.tenants.listSites(session.organizationId))[0];
    if (!site) throw new Error("Create a site before connecting Search Console.");
    const hostname = new URL(site.url).hostname.replace(/^www\./, "");
    const property = properties.find((item) => item.siteUrl === `sc-domain:${hostname}`)
      ?? properties.find((item) => item.siteUrl.startsWith(site.url)) ?? properties[0];
    if (!property) throw new Error("No Search Console properties are accessible to this Google account.");
    const existing = await runtime.tenants.getConnector(session.organizationId, "google-search-console");
    if (!tokens.refresh_token && !existing?.encryptedCredentials) throw new Error("Google did not return offline access. Revoke the app grant and reconnect to issue a refresh token.");
    await runtime.tenants.upsertConnector({ organizationId: session.organizationId, provider: "google-search-console", status: "connected", externalAccountId: session.email,
      ...(tokens.refresh_token ? { encryptedCredentials: encryptCredential(JSON.stringify({ refreshToken: tokens.refresh_token })) } : {}),
      health: { properties: properties.map((item) => ({ siteUrl: item.siteUrl, permissionLevel: item.permissionLevel })), selectedProperty: property.siteUrl } });
    await runtime.tenants.upsertSiteOnboarding({ organizationId: session.organizationId, siteId: site.id, state: "analytics", gscProperty: property.siteUrl });
    return NextResponse.redirect(new URL(state.returnTo, request.url));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Google OAuth failed.";
    const action = error instanceof ConnectorError ? error.action : "Return to onboarding and retry the Search Console connection.";
    try {
      const runtime = await onboardingRuntime();
      await runtime.tenants.upsertConnector({ organizationId: session.organizationId, provider: "google-search-console", status: "error", errorCode: error instanceof ConnectorError ? error.code : "invalid-config", errorMessage: message, health: { action } });
    } catch { /* Preserve the original actionable OAuth error. */ }
    return NextResponse.redirect(new URL(`/onboarding?error=${encodeURIComponent(`${message} ${action}`)}`, request.url));
  }
}
