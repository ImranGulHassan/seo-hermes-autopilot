import test from "node:test";
import assert from "node:assert/strict";
import { PostHogConversionClient, enrichWithConversions } from "../src/index.js";

test("queries PostHog with bound values and enriches matching landing pages", async () => {
  let requestBody: any;
  const client = new PostHogConversionClient({ personalApiKey: "phx_secret", projectId: 42, fetch: async (_input, init) => {
    requestBody = JSON.parse(String(init?.body));
    return Response.json({ results: [["https://example.com/guide", 3, 297]] });
  } });
  const conversions = await client.fetchLandingPageConversions({ startDate: "2026-01-01", endDate: "2026-01-28" }, "purchase", "revenue");
  assert.match(requestBody.query.query, /event = 'purchase'/);
  const enriched = enrichWithConversions([{ url: "https://example.com/guide", impressions: 1000, clicks: 50, ctr: 0.05, position: 5, conversions: 0, conversionValue: 0 }], conversions);
  assert.equal(enriched[0]?.conversions, 3);
  assert.equal(enriched[0]?.conversionValue, 297);
});

test("rejects unsafe dynamic property names before issuing a query", async () => {
  const client = new PostHogConversionClient({ personalApiKey: "token", projectId: 1, fetch: async () => { throw new Error("must not fetch"); } });
  await assert.rejects(() => client.fetchLandingPageConversions({ startDate: "2026-01-01", endDate: "2026-01-28" }, "purchase", "revenue); DROP TABLE events"), /Invalid/);
});

test("normalizes landing URLs and combines query-string variants", () => {
  const enriched = enrichWithConversions(
    [{ url: "https://example.com/guide", impressions: 10, clicks: 1, ctr: 0.1, position: 2, conversions: 0, conversionValue: 0 }],
    new Map([
      ["https://example.com/guide/?utm_source=google", { conversions: 2, conversionValue: 20 }],
      ["https://example.com/guide?ref=nav", { conversions: 1, conversionValue: 10 }],
      ["not a url", { conversions: 99, conversionValue: 999 }]
    ])
  );
  assert.equal(enriched[0]?.conversions, 3);
  assert.equal(enriched[0]?.conversionValue, 30);
});
