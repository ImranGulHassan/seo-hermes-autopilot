import { normalizeUrl, type SearchMetric } from "@seo-autopilot/core";
import { z } from "zod";
import { ConnectorError, connectorHttpError } from "./errors.js";

const queryResponseSchema = z.object({ results: z.array(z.tuple([z.string(), z.coerce.number(), z.coerce.number()])) });

export interface PostHogOptions {
  personalApiKey: string;
  projectId: string | number;
  host?: string;
  fetch?: typeof globalThis.fetch;
}

const projectSchema = z.object({ id: z.union([z.string(), z.number()]), name: z.string().default("PostHog project") });

export interface PostHogVerification { projectId: string; projectName: string; host: string; eventName: string | null; eventSeen: boolean | null }

export async function verifyPostHogConnection(input: PostHogOptions & { eventName?: string }): Promise<PostHogVerification> {
  if (!input.personalApiKey.trim() || !String(input.projectId).trim()) throw new ConnectorError("posthog", "invalid-config", "PostHog personal API key and project ID are required.", "Create a personal API key with project access and enter its project ID.");
  if (input.eventName && !/^[A-Za-z0-9_$ .:-]+$/.test(input.eventName)) throw new ConnectorError("posthog", "invalid-config", "PostHog event name contains unsupported characters.", "Choose an existing conversion event.");
  const host = (input.host ?? "https://us.posthog.com").replace(/\/$/, "");
  const fetcher = input.fetch ?? globalThis.fetch;
  const headers = { authorization: `Bearer ${input.personalApiKey}`, "content-type": "application/json" };
  const projectResponse = await fetcher(`${host}/api/projects/${encodeURIComponent(String(input.projectId))}/`, { headers });
  if (!projectResponse.ok) throw await connectorHttpError("posthog", projectResponse, "PostHog project verification");
  let project: z.infer<typeof projectSchema>;
  try { project = projectSchema.parse(await projectResponse.json()); }
  catch (cause) { throw new ConnectorError("posthog", "unexpected-response", "PostHog returned an invalid project response.", "Check the PostHog host and project ID.", undefined, { cause }); }
  let eventSeen: boolean | null = null;
  if (input.eventName) {
    const queryResponse = await fetcher(`${host}/api/projects/${encodeURIComponent(String(input.projectId))}/query/`, { method: "POST", headers, body: JSON.stringify({ query: { kind: "HogQLQuery", query: `SELECT count() FROM events WHERE event = '${input.eventName}' LIMIT 1` } }) });
    if (!queryResponse.ok) throw await connectorHttpError("posthog", queryResponse, "PostHog event verification");
    const query = z.object({ results: z.array(z.tuple([z.coerce.number()])) }).parse(await queryResponse.json());
    eventSeen = (query.results[0]?.[0] ?? 0) > 0;
  }
  return { projectId: String(project.id), projectName: project.name, host, eventName: input.eventName ?? null, eventSeen };
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
  const normalized = new Map<string, { conversions: number; conversionValue: number }>();
  for (const [rawUrl, value] of conversions) {
    try {
      const url = new URL(rawUrl);
      url.search = "";
      const key = normalizeUrl(url.toString());
      const prior = normalized.get(key) ?? { conversions: 0, conversionValue: 0 };
      normalized.set(key, { conversions: prior.conversions + value.conversions, conversionValue: prior.conversionValue + value.conversionValue });
    } catch { /* Ignore malformed analytics URLs instead of failing the scan. */ }
  }
  return metrics.map((metric) => {
    const url = new URL(metric.url);
    url.search = "";
    const value = normalized.get(normalizeUrl(url.toString()));
    return value ? { ...metric, ...value } : metric;
  });
}
