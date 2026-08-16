import { completedSearchWindow, GoogleOAuthTokenProvider, GoogleSearchConsoleClient } from "@seo-autopilot/connectors";
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
  const result = await runMeasurementSchedule({
    ledger,
    recrawls: { lastCrawledAt: (url) => gsc.lastCrawledAt(propertyUrl, url) },
    metrics: { observedBaseline: async (change: ChangeRecord, _day: 28 | 56, now: Date): Promise<MetricBaseline | null> => {
      const window = completedSearchWindow(now);
      const rows = await gsc.fetchPageMetrics(propertyUrl, window);
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
