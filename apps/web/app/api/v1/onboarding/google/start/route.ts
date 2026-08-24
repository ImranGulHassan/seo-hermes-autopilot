import { createGoogleOAuthState, googleOAuthAuthorizationUrl } from "@seo-autopilot/connectors";
import { NextResponse } from "next/server";
import { isResponse, onboardingOwner } from "../../../../../../lib/onboarding/runtime";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const session = await onboardingOwner();
  if (isResponse(session)) return session;
  const clientId = process.env.GOOGLE_CLIENT_ID, secret = process.env.SESSION_SECRET;
  if (!clientId || !secret) return NextResponse.json({ error: "Google OAuth is not configured.", action: "Configure GOOGLE_CLIENT_ID and SESSION_SECRET on the server." }, { status: 503 });
  const url = new URL(request.url), siteId = url.searchParams.get("siteId");
  if (!siteId) return NextResponse.json({ error: "Select a site before connecting Search Console." }, { status: 400 });
  const { onboardingRuntime } = await import("../../../../../../lib/onboarding/runtime");
  if (!(await (await onboardingRuntime()).tenants.getSite(session.organizationId, siteId))) return NextResponse.json({ error: "Selected site does not belong to this organization." }, { status: 404 });
  const redirectUri = process.env.GOOGLE_REDIRECT_URI ?? `${url.origin}/api/v1/onboarding/google/callback`;
  const state = createGoogleOAuthState({ organizationId: session.organizationId, userId: session.userId, returnTo: `/onboarding?siteId=${encodeURIComponent(siteId)}`, secret });
  return NextResponse.redirect(googleOAuthAuthorizationUrl({ clientId, redirectUri, state }));
}
