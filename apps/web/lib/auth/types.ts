export type OrganizationRole = "owner" | "approver" | "viewer";

export interface AuthPrincipal {
  userId: string;
  email: string;
  name: string | null;
  organizationId: string;
  organizationName: string;
  role: OrganizationRole;
}

export interface StoredSession extends AuthPrincipal {
  sessionId: string;
  expiresAt: Date;
  lastSeenAt: Date;
}

export interface AuthStore {
  consumeLoginToken(tokenHash: string, now: Date): Promise<AuthPrincipal | null>;
  createSession(input: { sessionId: string; tokenHash: string; principal: AuthPrincipal; expiresAt: Date; now: Date }): Promise<void>;
  findSession(tokenHash: string, now: Date): Promise<StoredSession | null>;
  touchSession(sessionId: string, now: Date): Promise<void>;
  revokeSession(sessionId: string, now: Date): Promise<void>;
}
