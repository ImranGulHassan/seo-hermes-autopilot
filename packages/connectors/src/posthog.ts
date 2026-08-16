import type { SearchMetric } from "@seo-autopilot/core";
import { z } from "zod";

const queryResponseSchema = z.object({ results: z.array(z.tuple([z.string(), z.coerce.number(), z.coerce.number()])) });

export interface PostHogOptions {
  personalApiKey: string;
  projectId: string | number;
  host?: string;
  fetch?: typeof globalThis.fetch;
}

export class PostHogConversionClient {
  private readonly fetcher: typeof globalThis.fetch;
  private readonly host: string;
  constructor(private readonly options: PostHogOptions) {
    if (!options.personalApiKey.trim()) throw new Error("A PostHog personal API key is required.");
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.host = (options.host ?? "https://us.posthog.com").replace(/\/$/, "");
  }

  async fetchLandingPageConversions(window: { startDate: string; endDate: string }, eventName: string, revenueProperty = "revenue"): Promise<Map<string, { conversions: number; conversionValue: number }>> {
    if (!/^[A-Za-z0-9_$ .:-]+$/.test(eventName) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(revenueProperty)) throw new Error("Invalid PostHog event or revenue property.");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(window.startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(window.endDate)) throw new Error("PostHog query dates must use YYYY-MM-DD.");
    const query = `SELECT properties.$current_url AS url, count() AS conversions, sumOrNull(toFloat(properties.${revenueProperty})) AS conversion_value FROM events WHERE event = '${eventName}' AND timestamp >= toDateTime('${window.startDate} 00:00:00') AND timestamp < toDateTime('${window.endDate} 23:59:59') AND properties.$current_url IS NOT NULL GROUP BY url`;
    const response = await this.fetcher(`${this.host}/api/projects/${encodeURIComponent(String(this.options.projectId))}/query/`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.options.personalApiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ query: { kind: "HogQLQuery", query } })
    });
    if (!response.ok) throw new Error(`PostHog query failed (${response.status}): ${(await response.text()).slice(0, 500)}`);
    const parsed = queryResponseSchema.parse(await response.json());
    return new Map(parsed.results.map(([url, conversions, conversionValue]) => [url, { conversions, conversionValue: conversionValue || 0 }]));
  }
}

export function enrichWithConversions(metrics: SearchMetric[], conversions: Map<string, { conversions: number; conversionValue: number }>): SearchMetric[] {
  return metrics.map((metric) => {
    const value = conversions.get(metric.url);
    return value ? { ...metric, ...value } : metric;
  });
}
