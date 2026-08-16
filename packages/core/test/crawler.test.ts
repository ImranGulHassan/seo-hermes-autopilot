import test from "node:test";
import assert from "node:assert/strict";
import { crawlSite } from "../src/index.js";

test("crawler discovers same-origin pages and annotates broken links and redirects", async () => {
  const responses = new Map<string, Response>([
    ["https://example.com/", new Response('<html><head><title>Home page title</title><meta name="description" content="A useful home page description that is long enough for validation."><link rel="canonical" href="/"></head><body><a href="/old">Old</a><a href="/gone">Gone</a><a href="https://outside.test">Outside</a></body></html>', { status: 200, headers: { "content-type": "text/html" } })],
    ["https://example.com/old", new Response("", { status: 301, headers: { location: "/new" } })],
    ["https://example.com/gone", new Response("", { status: 404 })]
  ]);
  const result = await crawlSite("https://example.com", {
    fetch: async (input) => responses.get(String(input))?.clone() ?? new Response("", { status: 404 }),
    maxPages: 10
  });
  const home = result.pages.find((page) => page.url === "https://example.com/");
  assert.equal(result.pages.length, 4);
  assert.equal(home?.internalLinks.find((link) => link.href.endsWith("/old"))?.redirectTarget, "https://example.com/new");
  assert.equal(home?.internalLinks.find((link) => link.href.endsWith("/gone"))?.status, 404);
  assert.equal(home?.internalLinks.some((link) => link.href.includes("outside.test")), false);
});

test("crawler follows a seed redirect and adopts its canonical www origin", async () => {
  const responses = new Map<string, Response>([
    ["https://example.com/", new Response("", { status: 307, headers: { location: "https://www.example.com/" } })],
    ["https://www.example.com/", new Response('<html><head><title>Canonical home title</title></head><body><a href="/guide">Guide</a></body></html>', { status: 200, headers: { "content-type": "text/html" } })],
    ["https://www.example.com/guide", new Response('<html><head><title>Canonical guide title</title></head><body>Guide</body></html>', { status: 200, headers: { "content-type": "text/html" } })]
  ]);
  const result = await crawlSite("https://example.com", {
    fetch: async (input) => responses.get(String(input))?.clone() ?? new Response("", { status: 404 })
  });
  assert.deepEqual(result.pages.map((page) => [page.url, page.status]), [
    ["https://example.com/", 307],
    ["https://www.example.com/", 200],
    ["https://www.example.com/guide", 200]
  ]);
});

test("discovers orphaned pages through robots and nested sitemap indexes", async () => {
  const responses = new Map<string, Response>([
    ["https://example.com/", new Response('<html><head><title>Home page title</title></head><body>Home</body></html>', { status: 200, headers: { "content-type": "text/html" } })],
    ["https://example.com/robots.txt", new Response("User-agent: *\nSitemap: https://example.com/sitemaps/index.xml\n", { status: 200 })],
    ["https://example.com/sitemap.xml", new Response("", { status: 404 })],
    ["https://example.com/sitemaps/index.xml", new Response('<?xml version="1.0"?><sitemapindex><sitemap><loc>https://example.com/sitemaps/pages.xml</loc></sitemap></sitemapindex>', { status: 200 })],
    ["https://example.com/sitemaps/pages.xml", new Response('<?xml version="1.0"?><urlset><url><loc>https://example.com/orphan</loc></url><url><loc>https://outside.test/unsafe</loc></url></urlset>', { status: 200 })],
    ["https://example.com/orphan", new Response('<html><head><title>Orphan page title</title></head><body>Orphan</body></html>', { status: 200, headers: { "content-type": "text/html" } })]
  ]);
  const result = await crawlSite("https://example.com", { fetch: async (input) => responses.get(String(input))?.clone() ?? new Response("", { status: 404 }) });
  assert.deepEqual(result.sitemapUrls, ["https://example.com/orphan"]);
  assert.equal(result.pages.find((page) => page.url.endsWith("/orphan"))?.sitemapListed, true);
  assert.equal(result.pages.some((page) => page.url.includes("outside.test")), false);
});

test("crawls explicit repository seeds without marking them as sitemap entries", async () => {
  const responses = new Map<string, Response>([
    ["https://example.com/", new Response('<html><head><title>Home page title</title></head><body>Home</body></html>', { status: 200, headers: { "content-type": "text/html" } })],
    ["https://example.com/robots.txt", new Response("", { status: 404 })],
    ["https://example.com/sitemap.xml", new Response('<?xml version="1.0"?><urlset><url><loc>https://example.com/</loc></url></urlset>', { status: 200 })],
    ["https://example.com/from-repository", new Response('<html><head><title>Repository route</title></head><body>Route</body></html>', { status: 200, headers: { "content-type": "text/html" } })]
  ]);
  const result = await crawlSite("https://example.com", { seedUrls: ["https://example.com/from-repository"], fetch: async (input) => responses.get(String(input))?.clone() ?? new Response("", { status: 404 }) });
  const repositoryPage = result.pages.find((page) => page.url.endsWith("/from-repository"));
  assert.equal(repositoryPage?.status, 200);
  assert.equal(repositoryPage?.sitemapListed, false);
});
