import type { Detector, DetectorContext, Opportunity, PageSnapshot, SearchMetric } from "./types.js";
import { median, stableId } from "./util.js";

function opportunity(input: Omit<Opportunity, "id" | "fingerprint"> & { key: unknown[] }): Opportunity {
  const fingerprint = stableId([input.type, ...input.key]);
  const { key: _, ...rest } = input;
  return { ...rest, fingerprint, id: `opp_${fingerprint}` };
}

function value(metric: SearchMetric | undefined, confidence = 1): number {
  if (!metric) return 1;
  const businessValue = metric.conversionValue > 0 ? metric.conversionValue : metric.clicks;
  return Math.round((metric.impressions * 0.01 + businessValue) * confidence * 100) / 100;
}

export const brokenLinkDetector: Detector = {
  type: "broken-link",
  detect({ pages, metricsByUrl }) {
    return pages.flatMap((page) => page.internalLinks.flatMap((link) => {
      if (link.status === undefined || (link.status < 400 && !link.redirectTarget)) return [];
      const isBroken = link.status >= 400;
      return [opportunity({
        key: [page.url, link.href, link.status, link.redirectTarget],
        type: "broken-link",
        title: isBroken ? "Repair broken internal link" : "Remove internal redirect hop",
        affectedUrls: [page.url, link.href],
        evidence: { source: page.url, target: link.href, status: link.status, redirectTarget: link.redirectTarget ?? null, anchor: link.anchor },
        confidence: "high",
        estimatedValue: value(metricsByUrl.get(page.url)),
        proposedFix: isBroken ? "Replace or remove the broken destination after verifying the intended page." : `Link directly to ${link.redirectTarget}.`,
        validation: ["Build succeeds", "All changed internal links return 2xx", "No redirect loop is introduced"],
        approvalPolicy: "eligible-after-trust-ramp"
      })];
    }));
  }
};

function defective(text: string | null, kind: "title" | "description"): boolean {
  if (!text || text.trim().length === 0) return true;
  const size = text.trim().length;
  // Display truncation is not a validity failure. Keep this detector focused on
  // clearly unusable metadata; CTR-driven rewrites belong to the CTR detector.
  return kind === "title" ? size < 10 || size > 120 : size < 40 || size > 300;
}

export const metadataDetector: Detector = {
  type: "metadata",
  detect({ pages, metricsByUrl }) {
    const titles = new Map<string, PageSnapshot[]>();
    const descriptions = new Map<string, PageSnapshot[]>();
    for (const page of pages.filter((candidate) => candidate.indexable)) {
      if (page.title) titles.set(page.title.trim().toLowerCase(), [...(titles.get(page.title.trim().toLowerCase()) ?? []), page]);
      if (page.description) descriptions.set(page.description.trim().toLowerCase(), [...(descriptions.get(page.description.trim().toLowerCase()) ?? []), page]);
    }
    return pages.filter((page) => page.indexable).flatMap((page) => {
      const issues: string[] = [];
      if (defective(page.title, "title")) issues.push("missing or defective title");
      if (defective(page.description, "description")) issues.push("missing or defective description");
      if (page.title && (titles.get(page.title.trim().toLowerCase())?.length ?? 0) > 1) issues.push("duplicate title");
      if (page.description && (descriptions.get(page.description.trim().toLowerCase())?.length ?? 0) > 1) issues.push("duplicate description");
      if (issues.length === 0) return [];
      return [opportunity({
        key: [page.url, issues.sort()],
        type: "metadata",
        title: "Repair page metadata",
        affectedUrls: [page.url],
        evidence: { issues, title: page.title, description: page.description },
        confidence: issues.some((issue) => issue.startsWith("missing")) ? "high" : "medium",
        estimatedValue: value(metricsByUrl.get(page.url), 0.7),
        proposedFix: "Write unique metadata grounded in the visible page content; do not add unsupported claims.",
        validation: ["Metadata is unique", "Title is descriptive and at most 120 characters", "Description is descriptive and at most 300 characters", "Build succeeds"],
        approvalPolicy: "eligible-after-trust-ramp"
      })];
    });
  }
};

export const underLinkedDetector: Detector = {
  type: "under-linked",
  detect({ pages, inboundLinkCounts, metricsByUrl }) {
    return pages.flatMap((page) => {
      const metric = metricsByUrl.get(page.url);
      const inbound = inboundLinkCounts.get(page.url) ?? 0;
      if (!page.indexable || !metric || metric.impressions < 100 || inbound >= 3) return [];
      return [opportunity({
        key: [page.url, inbound],
        type: "under-linked",
        title: "Add relevant internal links",
        affectedUrls: [page.url],
        evidence: { inboundLinks: inbound, impressions28d: metric.impressions },
        confidence: "high",
        estimatedValue: value(metric, 0.8),
        proposedFix: "Select contextually relevant source pages and propose natural anchors with surrounding text.",
        validation: ["At least three internal pages link to the target", "Anchors describe the destination", "Links render in visible content"],
        approvalPolicy: "required"
      })];
    });
  }
};

export const ctrAnomalyDetector: Detector = {
  type: "ctr-anomaly",
  detect({ metrics }) {
    const eligible = metrics.filter((metric) => metric.impressions >= 500);
    return eligible.flatMap((metric) => {
      const peers = eligible.filter((candidate) => Math.abs(candidate.position - metric.position) <= 1.5 && candidate.url !== metric.url);
      if (peers.length < 3) return [];
      const baseline = median(peers.map((peer) => peer.ctr));
      if (baseline <= 0 || metric.ctr >= baseline * 0.65) return [];
      return [opportunity({
        key: [metric.url, Math.round(baseline * 1000)],
        type: "ctr-anomaly",
        title: "Test a clearer search title and description",
        affectedUrls: [metric.url],
        evidence: { impressions28d: metric.impressions, ctr: metric.ctr, peerMedianCtr: baseline, position: metric.position, peerCount: peers.length },
        confidence: peers.length >= 8 ? "high" : "medium",
        estimatedValue: Math.round(metric.impressions * (baseline - metric.ctr) * 100) / 100,
        proposedFix: "Propose metadata aligned with page content and dominant query intent; treat the result as an experiment.",
        validation: ["Human approval recorded", "Metadata is accurate and unique", "Evaluate only after recrawl at days 28 and 56"],
        approvalPolicy: "required"
      })];
    });
  }
};

export const indexabilityDetector: Detector = {
  type: "indexability-conflict",
  detect({ pages, sitemapUrls = [], metricsByUrl }) {
    const sitemap = new Set(sitemapUrls);
    return pages.flatMap((page) => {
      const noindex = page.robots.some((directive) => directive.toLowerCase().includes("noindex"));
      const canonicalMismatch = page.status === 200 && page.canonical !== null && page.canonical !== page.url;
      const sitemapConflict = (sitemap.has(page.url) || page.sitemapListed) && (!page.indexable || noindex || page.status >= 300);
      const repositoryFailure = page.sourcePath !== null && page.status >= 400;
      const repositoryRedirect = page.sourcePath !== null && page.status >= 300 && page.status < 400;
      const repositorySitemapOmission = page.sourcePath !== null && page.indexable && !sitemap.has(page.url) && !page.sitemapListed;
      const issues = [
        ...(canonicalMismatch ? ["canonical points elsewhere"] : []),
        ...(sitemapConflict ? ["non-indexable URL is listed in sitemap"] : []),
        ...(repositoryFailure ? ["repository route does not return 200"] : []),
        ...(repositoryRedirect ? ["repository route redirects in production"] : []),
        ...(repositorySitemapOmission ? ["indexable repository route is absent from sitemap"] : []),
        ...(page.indexable && noindex ? ["indexability state conflicts with robots directive"] : [])
      ];
      if (issues.length === 0) return [];
      return [opportunity({
        key: [page.url, issues.sort()],
        type: "indexability-conflict",
        title: "Resolve indexability conflict",
        affectedUrls: [page.url],
        evidence: { issues, status: page.status, canonical: page.canonical, robots: page.robots, sitemapListed: sitemap.has(page.url) || page.sitemapListed },
        confidence: (repositorySitemapOmission || repositoryRedirect) && issues.length === 1 ? "medium" : "high",
        estimatedValue: value(metricsByUrl.get(page.url)),
        proposedFix: "Make status, canonical, robots directives, and sitemap membership express one reviewed indexing decision.",
        validation: ["Explicit human approval recorded", "Rendered canonical and robots agree", "Sitemap contains only canonical 2xx indexable URLs"],
        approvalPolicy: "required"
      })];
    });
  }
};

export const v1Detectors: Detector[] = [brokenLinkDetector, metadataDetector, underLinkedDetector, ctrAnomalyDetector, indexabilityDetector];

export function createDetectorContext(input: DetectorContext extends never ? never : { pages: PageSnapshot[]; metrics: SearchMetric[]; sitemapUrls?: string[] }): DetectorContext {
  const pagesByUrl = new Map(input.pages.map((page) => [page.url, page]));
  const metricsByUrl = new Map(input.metrics.map((metric) => [metric.url, metric]));
  const inboundLinkCounts = new Map<string, number>();
  for (const page of input.pages) {
    for (const link of page.internalLinks) inboundLinkCounts.set(link.href, (inboundLinkCounts.get(link.href) ?? 0) + 1);
  }
  return { ...input, pagesByUrl, metricsByUrl, inboundLinkCounts };
}

export function runDetectors(input: { pages: PageSnapshot[]; metrics: SearchMetric[]; sitemapUrls?: string[] }): Opportunity[] {
  const context = createDetectorContext(input);
  return v1Detectors.flatMap((detector) => detector.detect(context)).sort((a, b) => b.estimatedValue - a.estimatedValue);
}
