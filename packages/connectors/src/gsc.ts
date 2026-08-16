import type { SearchMetric, SearchQueryMetric } from "@seo-autopilot/core";
import { z } from "zod";

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
}

const oauthTokenSchema = z.object({ access_token: z.string().min(1), expires_in: z.number().positive().default(3600) });

export class GoogleOAuthTokenProvider {
  private cached?: { token: string; expiresAt: number };
  constructor(private readonly options: GoogleOAuthTokenProviderOptions) {
    if (![options.clientId, options.clientSecret, options.refreshToken].every((value) => value.trim())) throw new Error("Google client ID, client secret, and refresh token are required.");
  }
  async getAccessToken(): Promise<string> {
    const now = (this.options.now ?? (() => new Date()))().getTime();
    if (this.cached && this.cached.expiresAt - now > 60_000) return this.cached.token;
    const response = await (this.options.fetch ?? globalThis.fetch)(this.options.tokenEndpoint ?? "https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: this.options.clientId, client_secret: this.options.clientSecret, refresh_token: this.options.refreshToken, grant_type: "refresh_token" })
    });
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
      const response = await this.fetcher(`${this.endpoint}/sites/${encodeURIComponent(propertyUrl)}/searchAnalytics/query`, {
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
      });
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
    const response = await this.fetcher("https://searchconsole.googleapis.com/v1/urlInspection/index:inspect", {
      method: "POST",
      headers: { authorization: `Bearer ${this.options.accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ inspectionUrl, siteUrl: propertyUrl, languageCode: "en-US" })
    });
    if (!response.ok) throw new Error(`GSC URL inspection failed (${response.status}): ${(await response.text()).slice(0, 500)}`);
    const time = inspectionSchema.parse(await response.json()).inspectionResult?.indexStatusResult?.lastCrawlTime;
    return time ? new Date(time) : null;
  }
}
