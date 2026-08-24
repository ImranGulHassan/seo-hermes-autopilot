import type { SearchMetric, SearchQueryMetric } from "@seo-autopilot/core";
import { z } from "zod";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { ConnectorError, connectorHttpError } from "./errors.js";

const responseSchema = z.object({
  rows: z.array(z.object({
    keys: z.array(z.string()).min(1),
    clicks: z.number().nonnegative(),
    impressions: z.number().nonnegative(),
    ctr: z.number().min(0).max(1),
    position: z.number().nonnegative()
  })).optional().default([])
});
const inspectionSchema = z.object({ inspectionResult: z.object({ indexStatusResult: z.object({ lastCrawlTime: z.string().datetime().optional() }).optional() }).optional() });

export interface SearchWindow { startDate: string; endDate: string }

export interface GoogleOAuthTokenProviderOptions {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  fetch?: typeof globalThis.fetch;
  tokenEndpoint?: string;
  now?: () => Date;
  retries?: number;
  retryDelayMs?: number;
}

const oauthTokenSchema = z.object({ access_token: z.string().min(1), expires_in: z.number().positive().default(3600) });

export const GSC_OAUTH_SCOPES = ["https://www.googleapis.com/auth/webmasters.readonly"] as const;

export interface GoogleOAuthState { organizationId: string; userId: string; returnTo: string; nonce: string; expiresAt: string }

export function createGoogleOAuthState(input: { organizationId: string; userId: string; returnTo?: string; secret: string; now?: Date; ttlSeconds?: number; nonce?: string }): string {
  if (!input.organizationId.trim() || !input.userId.trim() || input.secret.length < 32) throw new ConnectorError("google-search-console", "invalid-config", "OAuth state requires an organization, user, and a secret of at least 32 characters.", "Configure a strong OAuth state secret.");
  const returnTo = input.returnTo ?? "/onboarding";
  if (!returnTo.startsWith("/") || returnTo.startsWith("//")) throw new ConnectorError("google-search-console", "invalid-config", "OAuth return path must be local.", "Use a relative path beginning with one slash.");
  const now = input.now ?? new Date();
  const payload: GoogleOAuthState = { organizationId: input.organizationId, userId: input.userId, returnTo, nonce: input.nonce ?? randomBytes(16).toString("base64url"), expiresAt: new Date(now.getTime() + (input.ttlSeconds ?? 600) * 1000).toISOString() };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${createHmac("sha256", input.secret).update(encoded).digest("base64url")}`;
}

export function verifyGoogleOAuthState(state: string, secret: string, now = new Date()): GoogleOAuthState {
  const [encoded, signature, extra] = state.split(".");
  if (!encoded || !signature || extra || secret.length < 32) throw new ConnectorError("google-search-console", "invalid-state", "Google OAuth state is invalid.", "Restart the Google Search Console connection.");
  const expected = createHmac("sha256", secret).update(encoded).digest("base64url");
  const receivedBytes = Buffer.from(signature); const expectedBytes = Buffer.from(expected);
  if (receivedBytes.length !== expectedBytes.length || !timingSafeEqual(receivedBytes, expectedBytes)) throw new ConnectorError("google-search-console", "invalid-state", "Google OAuth state signature is invalid.", "Restart the Google Search Console connection.");
  let parsed: GoogleOAuthState;
  try { parsed = z.object({ organizationId: z.string().min(1), userId: z.string().min(1), returnTo: z.string().regex(/^\/(?!\/)/), nonce: z.string().min(8), expiresAt: z.string().datetime() }).parse(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"))); }
  catch (cause) { throw new ConnectorError("google-search-console", "invalid-state", "Google OAuth state payload is invalid.", "Restart the Google Search Console connection.", undefined, { cause }); }
  if (new Date(parsed.expiresAt) <= now) throw new ConnectorError("google-search-console", "expired-state", "Google OAuth state has expired.", "Restart the Google Search Console connection.");
  return parsed;
}

export function googleOAuthAuthorizationUrl(input: { clientId: string; redirectUri: string; state: string; loginHint?: string; authorizationEndpoint?: string }): string {
  if (!input.clientId.trim() || !input.redirectUri.trim() || !input.state.trim()) throw new ConnectorError("google-search-console", "invalid-config", "Google OAuth client ID, redirect URI, and state are required.", "Complete the Google OAuth configuration.");
  const url = new URL(input.authorizationEndpoint ?? "https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({ client_id: input.clientId, redirect_uri: input.redirectUri, response_type: "code", scope: GSC_OAUTH_SCOPES.join(" "), access_type: "offline", prompt: "consent select_account", state: input.state, ...(input.loginHint ? { login_hint: input.loginHint } : {}) }).toString();
  return url.toString();
}

const codeTokenSchema = oauthTokenSchema.extend({ refresh_token: z.string().min(1).optional(), scope: z.string().optional(), token_type: z.string().optional() });
export type GoogleOAuthCodeTokens = z.infer<typeof codeTokenSchema>;

export async function exchangeGoogleOAuthCode(input: { clientId: string; clientSecret: string; code: string; redirectUri: string; fetch?: typeof globalThis.fetch; tokenEndpoint?: string }): Promise<GoogleOAuthCodeTokens> {
  if (![input.clientId, input.clientSecret, input.code, input.redirectUri].every((value) => value.trim())) throw new ConnectorError("google-search-console", "invalid-config", "Google OAuth code exchange is missing required configuration.", "Check the OAuth client and retry the connection.");
  const response = await (input.fetch ?? globalThis.fetch)(input.tokenEndpoint ?? "https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: input.clientId, client_secret: input.clientSecret, code: input.code, redirect_uri: input.redirectUri, grant_type: "authorization_code" }) });
  if (!response.ok) throw await connectorHttpError("google-search-console", response, "Google OAuth code exchange");
  try { return codeTokenSchema.parse(await response.json()); }
  catch (cause) { throw new ConnectorError("google-search-console", "unexpected-response", "Google returned an invalid OAuth token response.", "Retry the connection; if it persists, check the OAuth client configuration.", undefined, { cause }); }
}

const sitesSchema = z.object({ siteEntry: z.array(z.object({ siteUrl: z.string().min(1), permissionLevel: z.string().min(1) })).optional().default([]) });
export interface GscProperty { siteUrl: string; permissionLevel: string; writable: boolean }

export async function listSearchConsoleProperties(input: { accessToken: string; fetch?: typeof globalThis.fetch; endpoint?: string }): Promise<GscProperty[]> {
  if (!input.accessToken.trim()) throw new ConnectorError("google-search-console", "invalid-config", "A Google access token is required.", "Reconnect Google Search Console.");
  const response = await (input.fetch ?? globalThis.fetch)(`${(input.endpoint ?? "https://searchconsole.googleapis.com/webmasters/v3").replace(/\/$/, "")}/sites`, { headers: { authorization: `Bearer ${input.accessToken}` } });
  if (!response.ok) throw await connectorHttpError("google-search-console", response, "Search Console property listing");
  const parsed = sitesSchema.parse(await response.json());
  return parsed.siteEntry.map((entry) => ({ ...entry, writable: ["siteOwner", "siteFullUser"].includes(entry.permissionLevel) }));
}

export async function verifySearchConsoleProperty(input: { accessToken: string; propertyUrl: string; fetch?: typeof globalThis.fetch; endpoint?: string }): Promise<GscProperty> {
  const properties = await listSearchConsoleProperties(input);
  const property = properties.find((entry) => entry.siteUrl === input.propertyUrl);
  if (!property) throw new ConnectorError("google-search-console", "not-found", `Search Console property ${input.propertyUrl} is not accessible.`, "Select an available property or grant this Google account access.");
  return property;
}

export class GoogleOAuthTokenProvider {
  private cached?: { token: string; expiresAt: number };
  constructor(private readonly options: GoogleOAuthTokenProviderOptions) {
    if (![options.clientId, options.clientSecret, options.refreshToken].every((value) => value.trim())) throw new Error("Google client ID, client secret, and refresh token are required.");
  }
  async getAccessToken(): Promise<string> {
    const now = (this.options.now ?? (() => new Date()))().getTime();
    if (this.cached && this.cached.expiresAt - now > 60_000) return this.cached.token;
    const response = await fetchWithRetry(this.options.fetch ?? globalThis.fetch, this.options.tokenEndpoint ?? "https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: this.options.clientId, client_secret: this.options.clientSecret, refresh_token: this.options.refreshToken, grant_type: "refresh_token" })
    }, this.options.retries, this.options.retryDelayMs);
    if (!response.ok) throw new Error(`Google OAuth refresh failed (${response.status}): ${(await response.text()).slice(0, 500)}`);
    const token = oauthTokenSchema.parse(await response.json());
    this.cached = { token: token.access_token, expiresAt: now + token.expires_in * 1000 };
    return token.access_token;
  }
}

export interface GscClientOptions {
  accessToken: string;
  fetch?: typeof globalThis.fetch;
  endpoint?: string;
  rowLimit?: number;
  maxRows?: number;
  retries?: number;
  retryDelayMs?: number;
}

export function completedSearchWindow(now = new Date(), days = 28, lagDays = 3): SearchWindow {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  end.setUTCDate(end.getUTCDate() - lagDays);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - days + 1);
  return { startDate: formatDate(start), endDate: formatDate(end) };
}

function formatDate(date: Date): string { return date.toISOString().slice(0, 10); }

export class GoogleSearchConsoleClient {
  private readonly fetcher: typeof globalThis.fetch;
  private readonly endpoint: string;
  private readonly rowLimit: number;
  private readonly maxRows: number;

  constructor(private readonly options: GscClientOptions) {
    if (!options.accessToken.trim()) throw new Error("A non-empty GSC access token is required.");
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.endpoint = options.endpoint ?? "https://searchconsole.googleapis.com/webmasters/v3";
    this.rowLimit = Math.min(options.rowLimit ?? 25_000, 25_000);
    this.maxRows = Math.min(options.maxRows ?? 50_000, 50_000);
  }

  async fetchPageMetrics(propertyUrl: string, window = completedSearchWindow()): Promise<SearchMetric[]> {
    const rows = await this.fetchMetrics(propertyUrl, window, "page", "byPage");
    return rows.map((row) => ({
      url: row.keys[0]!, clicks: row.clicks, impressions: row.impressions, ctr: row.ctr, position: row.position,
      conversions: 0, conversionValue: 0
    }));
  }

  async fetchQueryMetrics(propertyUrl: string, window = completedSearchWindow()): Promise<SearchQueryMetric[]> {
    const rows = await this.fetchMetrics(propertyUrl, window, "query", "auto");
    return rows.map((row) => ({ query: row.keys[0]!, clicks: row.clicks, impressions: row.impressions, ctr: row.ctr, position: row.position }));
  }

  private async fetchMetrics(propertyUrl: string, window: SearchWindow, dimension: "page" | "query", aggregationType: "byPage" | "auto"): Promise<z.infer<typeof responseSchema>["rows"]> {
    const rows: z.infer<typeof responseSchema>["rows"] = [];
    for (let startRow = 0; startRow < this.maxRows; startRow += this.rowLimit) {
      const response = await fetchWithRetry(this.fetcher, `${this.endpoint}/sites/${encodeURIComponent(propertyUrl)}/searchAnalytics/query`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.options.accessToken}`, "content-type": "application/json" },
        body: JSON.stringify({
          startDate: window.startDate,
          endDate: window.endDate,
          dimensions: [dimension],
          aggregationType,
          dataState: "final",
          rowLimit: Math.min(this.rowLimit, this.maxRows - startRow),
          startRow
        })
      }, this.options.retries, this.options.retryDelayMs);
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 500);
        throw new Error(`GSC request failed (${response.status}): ${detail || response.statusText}`);
      }
      const page = responseSchema.parse(await response.json());
      rows.push(...page.rows);
      if (page.rows.length < this.rowLimit) break;
    }
    return rows;
  }

  async lastCrawledAt(propertyUrl: string, inspectionUrl: string): Promise<Date | null> {
    const response = await fetchWithRetry(this.fetcher, "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect", {
      method: "POST",
      headers: { authorization: `Bearer ${this.options.accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ inspectionUrl, siteUrl: propertyUrl, languageCode: "en-US" })
    }, this.options.retries, this.options.retryDelayMs);
    if (!response.ok) throw new Error(`GSC URL inspection failed (${response.status}): ${(await response.text()).slice(0, 500)}`);
    const time = inspectionSchema.parse(await response.json()).inspectionResult?.indexStatusResult?.lastCrawlTime;
    return time ? new Date(time) : null;
  }
}

async function fetchWithRetry(
  fetcher: typeof globalThis.fetch,
  input: string,
  init: RequestInit,
  retries = 2,
  retryDelayMs = 250
): Promise<Response> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetcher(input, init);
      if (!isTransientStatus(response.status) || attempt >= retries) return response;
    } catch (error) {
      if (attempt >= retries) throw error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, retryDelayMs * 2 ** attempt));
  }
}

function isTransientStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}
