import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getAuthStore } from "./store";
import { createSessionToken, hashToken, readSessionToken } from "./token";
import type { AuthPrincipal, OrganizationRole, StoredSession } from "./types";

export const SESSION_COOKIE = "seo_autopilot_session";
export const SESSION_DURATION_SECONDS = 60 * 60 * 24 * 14;

function secret(): string {
  const value = process.env.SESSION_SECRET;
  if (!value || value.length < 32) throw new Error("SESSION_SECRET must contain at least 32 characters.");
  return value;
}

export async function issueSession(principal: AuthPrincipal, now = new Date()): Promise<void> {
  const token = createSessionToken(secret());
  const expiresAt = new Date(now.getTime() + SESSION_DURATION_SECONDS * 1000);
  await getAuthStore().createSession({ sessionId: token.sessionId, tokenHash: token.tokenHash, principal, expiresAt, now });
  (await cookies()).set(SESSION_COOKIE, token.cookieValue, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_DURATION_SECONDS,
  });
}

export async function currentSession(now = new Date()): Promise<StoredSession | null> {
  const value = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!value) return null;
  const parsed = readSessionToken(value, secret());
  if (!parsed) return null;
  const session = await getAuthStore().findSession(parsed.tokenHash, now);
  if (session && now.getTime() - session.lastSeenAt.getTime() >= 5 * 60 * 1000) {
    await getAuthStore().touchSession(session.sessionId, now);
  }
  return session;
}

export async function revokeCurrentSession(now = new Date()): Promise<void> {
  const jar = await cookies();
  const value = jar.get(SESSION_COOKIE)?.value;
  const parsed = value ? readSessionToken(value, secret()) : null;
  if (parsed) {
    const session = await getAuthStore().findSession(parsed.tokenHash, now);
    if (session) await getAuthStore().revokeSession(session.sessionId, now);
  }
  jar.set(SESSION_COOKIE, "", { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: 0 });
}

export async function redeemLoginToken(rawToken: string, now = new Date()): Promise<AuthPrincipal | null> {
  if (rawToken.length < 32 || rawToken.length > 512) return null;
  return getAuthStore().consumeLoginToken(hashToken(rawToken), now);
}

export async function requireSession(returnTo = "/"): Promise<StoredSession> {
  const session = await currentSession();
  if (!session) redirect(`/login?returnTo=${encodeURIComponent(returnTo)}`);
  return session;
}

const roleRank: Record<OrganizationRole, number> = { viewer: 0, approver: 1, owner: 2 };
export function hasMinimumRole(actual: OrganizationRole, required: OrganizationRole): boolean {
  return roleRank[actual] >= roleRank[required];
}

export async function requireRole(required: OrganizationRole, returnTo = "/"): Promise<StoredSession> {
  const session = await requireSession(returnTo);
  if (!hasMinimumRole(session.role, required)) redirect("/?error=forbidden");
  return session;
}
