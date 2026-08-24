import { createPool, type Queryable } from "@seo-autopilot/database";
import type { AuthPrincipal, AuthStore, OrganizationRole, StoredSession } from "./types";

interface PrincipalRow {
  user_id: string;
  email: string;
  name: string | null;
  organization_id: string;
  organization_name: string;
  role: OrganizationRole;
}

export class PostgresAuthStore implements AuthStore {
  constructor(private readonly database: Queryable) {}

  async consumeLoginToken(tokenHash: string, now: Date): Promise<AuthPrincipal | null> {
    const result = await this.database.query<PrincipalRow>(
      `UPDATE login_tokens t SET used_at=$2
       FROM users u, memberships m, organizations o
       WHERE t.token_hash=$1 AND t.used_at IS NULL AND t.expires_at>$2
         AND u.id=t.user_id AND m.user_id=u.id AND m.organization_id=t.organization_id AND o.id=t.organization_id
       RETURNING u.id AS user_id,u.email,u.name,o.id AS organization_id,o.name AS organization_name,m.role`,
      [tokenHash, now]
    );
    return result.rows[0] ? toPrincipal(result.rows[0]) : null;
  }

  async createSession(input: { sessionId: string; tokenHash: string; principal: AuthPrincipal; expiresAt: Date; now: Date }): Promise<void> {
    await this.database.query(
      `INSERT INTO auth_sessions(id,user_id,organization_id,token_hash,expires_at,last_seen_at)
       VALUES($1,$2,$3,$4,$5,$6)`,
      [input.sessionId, input.principal.userId, input.principal.organizationId, input.tokenHash, input.expiresAt, input.now]
    );
  }

  async findSession(tokenHash: string, now: Date): Promise<StoredSession | null> {
    const result = await this.database.query<PrincipalRow & { session_id: string; expires_at: Date; last_seen_at: Date }>(
      `SELECT s.id AS session_id,s.expires_at,s.last_seen_at,u.id AS user_id,u.email,u.name,
              o.id AS organization_id,o.name AS organization_name,m.role
       FROM auth_sessions s
       JOIN users u ON u.id=s.user_id
       JOIN organizations o ON o.id=s.organization_id
       JOIN memberships m ON m.user_id=u.id AND m.organization_id=o.id
       WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>$2 AND u.disabled_at IS NULL`,
      [tokenHash, now]
    );
    const row = result.rows[0];
    return row ? { ...toPrincipal(row), sessionId: row.session_id, expiresAt: new Date(row.expires_at), lastSeenAt: new Date(row.last_seen_at) } : null;
  }

  async touchSession(sessionId: string, now: Date): Promise<void> {
    await this.database.query("UPDATE auth_sessions SET last_seen_at=$2 WHERE id=$1", [sessionId, now]);
  }

  async revokeSession(sessionId: string, now: Date): Promise<void> {
    await this.database.query("UPDATE auth_sessions SET revoked_at=$2 WHERE id=$1 AND revoked_at IS NULL", [sessionId, now]);
  }
}

function toPrincipal(row: PrincipalRow): AuthPrincipal {
  return { userId: row.user_id, email: row.email, name: row.name, organizationId: row.organization_id, organizationName: row.organization_name, role: row.role };
}

let singleton: AuthStore | undefined;
export function getAuthStore(): AuthStore {
  if (singleton) return singleton;
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required for authentication.");
  singleton = new PostgresAuthStore(createPool({ connectionString: databaseUrl }));
  return singleton;
}
