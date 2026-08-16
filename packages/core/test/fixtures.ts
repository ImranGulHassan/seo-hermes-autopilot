import type { MetricBaseline, PageSnapshot, SearchMetric } from "../src/index.js";

export const pages: PageSnapshot[] = [
  {
    url: "https://example.com/guide",
    status: 200,
    title: "Guide",
    description: null,
    canonical: "https://example.com/guide",
    robots: [],
    sitemapListed: true,
    indexable: true,
    sourcePath: "content/guide.mdx",
    internalLinks: [{ href: "https://example.com/gone", anchor: "old page", status: 404 }]
  },
  {
    url: "https://example.com/low-ctr",
    status: 200,
    title: "A useful and unique title for the low CTR page",
    description: "A complete description of this useful page with enough specific detail for a search visitor.",
    canonical: "https://example.com/other",
    robots: [],
    sitemapListed: true,
    indexable: true,
    sourcePath: "content/low-ctr.mdx",
    internalLinks: []
  }
];

export const metrics: SearchMetric[] = [
  { url: "https://example.com/guide", impressions: 200, clicks: 10, ctr: 0.05, position: 8, conversions: 1, conversionValue: 100 },
  { url: "https://example.com/low-ctr", impressions: 1000, clicks: 10, ctr: 0.01, position: 5, conversions: 0, conversionValue: 0 },
  ...[1, 2, 3, 4].map((index) => ({ url: `https://example.com/peer-${index}`, impressions: 1000, clicks: 50, ctr: 0.05, position: 5 + index / 10, conversions: 0, conversionValue: 0 }))
];

export const baseline: MetricBaseline = {
  startDate: "2026-01-01",
  endDate: "2026-01-28",
  impressions: 1000,
  clicks: 50,
  ctr: 0.05,
  position: 6,
  conversions: 5,
  conversionValue: 500,
  indexed: true
};
