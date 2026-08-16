import { completedSearchWindow, enrichWithConversions, GoogleOAuthTokenProvider, GoogleSearchConsoleClient, PostHogConversionClient } from "@seo-autopilot/connectors";
import { runMeasurementSchedule, type ChangeRecord, type MetricBaseline } from "@seo-autopilot/core";
import { createPool, migrate, PostgresChangeLedger } from "@seo-autopilot/database";

const databaseUrl = process.env.DATABASE_URL;
const propertyUrl = process.env.GSC_PROPERTY_URL;
if (!databaseUrl || !propertyUrl) throw new Error("DATABASE_URL and GSC_PROPERTY_URL are required.");
const accessToken = await googleAccessToken();
if (!accessToken) throw new Error("GSC_ACCESS_TOKEN or Google OAuth refresh credentials are required.");
const pool = createPool({ connectionString: databaseUrl });
try {
  await migrate(pool);
  const ledger = new PostgresChangeLedger(pool);
  const gsc = new GoogleSearchConsoleClient({ accessToken });
  const conversionCache = new Map<string, Awaited<ReturnType<PostHogConversionClient["fetchLandingPageConversions"]>>>();
  const result = await runMeasurementSchedule({
    ledger,
    recrawls: { lastCrawledAt: (url) => gsc.lastCrawledAt(propertyUrl, url) },
    metrics: { observedBaseline: async (change: ChangeRecord, _day: 28 | 56, now: Date): Promise<MetricBaseline | null> => {
      const window = completedSearchWindow(now);
      let rows = await gsc.fetchPageMetrics(propertyUrl, window);
      const posthog = posthogClient();
      const eventName = process.env.POSTHOG_CONVERSION_EVENT?.trim();
      if (posthog && eventName) {
        const cacheKey = `${window.startDate}:${window.endDate}`;
        let conversions = conversionCache.get(cacheKey);
        if (!conversions) {
          conversions = await posthog.fetchLandingPageConversions(window, eventName, process.env.POSTHOG_REVENUE_PROPERTY?.trim() || "revenue");
          conversionCache.set(cacheKey, conversions);
        }
        rows = enrichWithConversions(rows, conversions);
      }
      const selected = rows.filter((row) => change.affectedUrls.includes(row.url));
      if (selected.length === 0) return null;
      const impressions = selected.reduce((sum, row) => sum + row.impressions, 0);
      const clicks = selected.reduce((sum, row) => sum + row.clicks, 0);
      return {
        ...window, impressions, clicks, ctr: impressions > 0 ? clicks / impressions : 0,
        position: impressions > 0 ? selected.reduce((sum, row) => sum + row.position * row.impressions, 0) / impressions : 0,
        conversions: selected.reduce((sum, row) => sum + row.conversions, 0),
        conversionValue: selected.reduce((sum, row) => sum + row.conversionValue, 0), indexed: true
      };
    } }
  });
  console.log(JSON.stringify(result));
} finally { await pool.end(); }

async function googleAccessToken(): Promise<string | undefined> {
  const { GOOGLE_CLIENT_ID: clientId, GOOGLE_CLIENT_SECRET: clientSecret, GOOGLE_REFRESH_TOKEN: refreshToken } = process.env;
  if (clientId && clientSecret && refreshToken) return new GoogleOAuthTokenProvider({ clientId, clientSecret, refreshToken }).getAccessToken();
  return process.env.GSC_ACCESS_TOKEN?.trim() || undefined;
}

function posthogClient(): PostHogConversionClient | undefined {
  const personalApiKey = process.env.POSTHOG_PERSONAL_API_KEY?.trim();
  const projectId = process.env.POSTHOG_PROJECT_ID?.trim();
  if (!personalApiKey || !projectId) return undefined;
  const host = process.env.POSTHOG_API_HOST?.trim();
  return new PostHogConversionClient({ personalApiKey, projectId, ...(host ? { host } : {}) });
}
