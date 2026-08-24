import { createGoogleOAuthState, googleOAuthAuthorizationUrl } from "@seo-autopilot/connectors";
import { NextResponse } from "next/server";
import { isResponse, onboardingOwner } from "../../../../../../lib/onboarding/runtime";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const session = await onboardingOwner();
  if (isResponse(session)) return session;
  const clientId = process.env.GOOGLE_CLIENT_ID, secret = process.env.SESSION_SECRET;
  if (!clientId || !secret) return NextResponse.json({ error: "Google OAuth is not configured.", action: "Configure GOOGLE_CLIENT_ID and SESSION_SECRET on the server." }, { status: 503 });
  const redirectUri = process.env.GOOGLE_REDIRECT_URI ?? `${new URL(request.url).origin}/api/v1/onboarding/google/callback`;
  const state = createGoogleOAuthState({ organizationId: session.organizationId, userId: session.userId, returnTo: "/onboarding", secret });
  return NextResponse.redirect(googleOAuthAuthorizationUrl({ clientId, redirectUri, state }));
}
