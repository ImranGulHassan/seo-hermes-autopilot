import * as cheerio from "cheerio";
import type { PageSnapshot } from "./types.js";
import { normalizeUrl } from "./util.js";

export interface CrawlOptions {
  maxPages?: number;
  concurrency?: number;
  maxTransientRetries?: number;
  retryDelayMs?: number;
  userAgent?: string;
  sitemapUrls?: string[];
  seedUrls?: string[];
  fetch?: typeof globalThis.fetch;
}

export interface CrawlResult {
  pages: PageSnapshot[];
  errors: Array<{ url: string; error: string }>;
  sitemapUrls: string[];
}

function hasAllowedOrigin(candidate: string, origins: Set<string>): boolean {
  try { return origins.has(new URL(candidate).origin); } catch { return false; }
}

export async function crawlSite(startUrl: string, options: CrawlOptions = {}): Promise<CrawlResult> {
  const fetcher = options.fetch ?? globalThis.fetch;
  const maxPages = options.maxPages ?? 500;
  const concurrency = Math.max(1, options.concurrency ?? 4);
  const normalizedStartUrl = normalizeUrl(startUrl);
  const allowedOrigins = new Set([new URL(normalizedStartUrl).origin]);
  const queue = [normalizedStartUrl];
  const queued = new Set(queue);
  const pages: PageSnapshot[] = [];
  const errors: CrawlResult["errors"] = [];
  const redirectsByUrl = new Map<string, string>();
  const sitemapUrls = new Set((options.sitemapUrls ?? []).map(normalizeUrl));

  async function fetchPage(url: string): Promise<Response> {
    const maxRetries = Math.max(0, options.maxTransientRetries ?? 2);
    for (let attempt = 0; ; attempt += 1) {
      const response = await fetcher(url, {
        redirect: "manual",
        headers: { "user-agent": options.userAgent ?? "SEO-Autopilot/0.1 (+site-owner-crawler)" },
      });
      const transient = response.status === 429 || response.status >= 500;
      if (!transient || attempt >= maxRetries) return response;
      await response.body?.cancel();
      const delayMs = Math.max(0, options.retryDelayMs ?? 250) * 2 ** attempt;
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  async function visit(url: string): Promise<void> {
    try {
      const response = await fetchPage(url);
      const contentType = response.headers.get("content-type") ?? "";
      const redirectTarget = response.headers.get("location");
      if (redirectTarget && response.status >= 300 && response.status < 400) {
        const absoluteTarget = normalizeUrl(new URL(redirectTarget, url).toString());
        redirectsByUrl.set(url, absoluteTarget);
        // It is common for the entered apex domain to redirect to its www
        // canonical. Adopt that origin only for the seed redirect; arbitrary
        // off-site redirects found later remain outside the crawl boundary.
        if (url === normalizedStartUrl) allowedOrigins.add(new URL(absoluteTarget).origin);
        if (hasAllowedOrigin(absoluteTarget, allowedOrigins) && !queued.has(absoluteTarget) && queued.size < maxPages) {
          queued.add(absoluteTarget);
          queue.push(absoluteTarget);
        }
      }
      if (!contentType.includes("text/html")) {
        pages.push({ url, status: response.status, title: null, description: null, canonical: null, robots: [], sitemapListed: sitemapUrls.has(url), indexable: false, internalLinks: [], sourcePath: null });
        return;
      }
      const html = await response.text();
      const $ = cheerio.load(html);
      const robots = ($('meta[name="robots"]').attr("content") ?? "").split(",").map((item) => item.trim()).filter(Boolean);
      const canonicalRaw = $('link[rel="canonical"]').attr("href");
      const links = $("a[href]").toArray().flatMap((element) => {
        const href = $(element).attr("href");
        if (!href) return [];
        try {
          const absolute = normalizeUrl(new URL(href, url).toString());
          if (!hasAllowedOrigin(absolute, allowedOrigins)) return [];
          return [{ href: absolute, anchor: $(element).text().trim() }];
        } catch { return []; }
      });
      for (const link of links) {
        if (!queued.has(link.href) && queued.size < maxPages) { queued.add(link.href); queue.push(link.href); }
      }
      const noindex = robots.some((directive) => directive.toLowerCase() === "noindex");
      pages.push({
        url,
        status: response.status,
        title: $("title").first().text().trim() || null,
        description: $('meta[name="description"]').attr("content")?.trim() || null,
        canonical: canonicalRaw ? normalizeUrl(new URL(canonicalRaw, url).toString()) : null,
        robots,
        sitemapListed: sitemapUrls.has(url),
        indexable: response.status === 200 && !noindex,
        internalLinks: links,
        sourcePath: null
      });
    } catch (error) {
      errors.push({ url, error: error instanceof Error ? error.message : String(error) });
    }
  }

  // Visit the seed first so an apex -> www redirect establishes the canonical
  // crawl origin before sitemap entries are accepted.
  queue.shift();
  await visit(normalizedStartUrl);
  if (options.sitemapUrls === undefined) {
    for (const url of await discoverSitemapUrls(allowedOrigins, fetcher, options.userAgent, maxPages)) sitemapUrls.add(url);
  }
  for (const url of sitemapUrls) {
    if (hasAllowedOrigin(url, allowedOrigins) && !queued.has(url) && queued.size < maxPages) { queued.add(url); queue.push(url); }
  }
  for (const candidate of options.seedUrls ?? []) {
    try {
      const url = normalizeUrl(candidate);
      if (hasAllowedOrigin(url, allowedOrigins) && !queued.has(url) && queued.size < maxPages) { queued.add(url); queue.push(url); }
    } catch { /* Invalid optional seeds do not abort the technical crawl. */ }
  }
  for (const page of pages) page.sitemapListed = sitemapUrls.has(page.url);

  while (queue.length > 0 && pages.length + errors.length < maxPages) {
    const batch = queue.splice(0, concurrency);
    await Promise.all(batch.map(visit));
  }

  const statusByUrl = new Map(pages.map((page) => [page.url, page.status]));
  for (const page of pages) {
    page.internalLinks = page.internalLinks.map((link) => {
      const status = statusByUrl.get(link.href);
      const target = redirectsByUrl.get(link.href);
      return { ...link, ...(status === undefined ? {} : { status }), ...(target ? { redirectTarget: target } : {}) };
    });
  }
  return { pages, errors, sitemapUrls: [...sitemapUrls].sort() };
}

async function discoverSitemapUrls(origins: Set<string>, fetcher: typeof globalThis.fetch, userAgent: string | undefined, maxUrls: number): Promise<string[]> {
  const sitemapQueue: string[] = [];
  for (const origin of origins) {
    try {
      const robots = await fetcher(new URL("/robots.txt", origin), { headers: { "user-agent": userAgent ?? "SEO-Autopilot/0.1 (+site-owner-crawler)" } });
      if (robots.ok) {
        const body = await robots.text();
        for (const match of body.matchAll(/^sitemap:\s*(\S+)\s*$/gim)) sitemapQueue.push(new URL(match[1]!, origin).toString());
      }
    } catch { /* The conventional sitemap URL is still attempted. */ }
    sitemapQueue.push(new URL("/sitemap.xml", origin).toString());
  }
  const visited = new Set<string>();
  const urls = new Set<string>();
  while (sitemapQueue.length > 0 && visited.size < 50 && urls.size < maxUrls) {
    const sitemapUrl = sitemapQueue.shift()!;
    if (visited.has(sitemapUrl) || !hasAllowedOrigin(sitemapUrl, origins)) continue;
    visited.add(sitemapUrl);
    try {
      const response = await fetcher(sitemapUrl, { headers: { "user-agent": userAgent ?? "SEO-Autopilot/0.1 (+site-owner-crawler)" } });
      if (!response.ok) continue;
      const xml = await response.text();
      const $ = cheerio.load(xml, { xmlMode: true });
      const locations = $("loc").toArray().map((node) => $(node).text().trim()).filter(Boolean);
      if ($("sitemapindex").length > 0) {
        for (const location of locations) {
          try { const normalized = normalizeUrl(location); if (hasAllowedOrigin(normalized, origins)) sitemapQueue.push(normalized); } catch { /* Ignore malformed entries. */ }
        }
      } else {
        for (const location of locations) {
          try { const normalized = normalizeUrl(location); if (hasAllowedOrigin(normalized, origins)) urls.add(normalized); } catch { /* Ignore malformed entries. */ }
          if (urls.size >= maxUrls) break;
        }
      }
    } catch { /* Sitemap discovery is optional and non-destructive. */ }
  }
  return [...urls];
}
