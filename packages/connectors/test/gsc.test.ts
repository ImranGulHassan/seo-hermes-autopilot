import test from "node:test";
import assert from "node:assert/strict";
import { GoogleOAuthTokenProvider, GoogleSearchConsoleClient, completedSearchWindow } from "../src/index.js";

test("uses a completed 28-day window excluding the trailing three days", () => {
  assert.deepEqual(completedSearchWindow(new Date("2026-08-15T20:00:00Z")), { startDate: "2026-07-16", endDate: "2026-08-12" });
});

test("paginates page metrics and normalizes absent analytics values", async () => {
  const requests: Array<{ url: string; body: Record<string, unknown>; authorization: string | null }> = [];
  const pages = [
    { rows: [
      { keys: ["https://example.com/a"], clicks: 5, impressions: 100, ctr: 0.05, position: 4 },
      { keys: ["https://example.com/b"], clicks: 3, impressions: 100, ctr: 0.03, position: 7 }
    ] },
    { rows: [{ keys: ["https://example.com/c"], clicks: 1, impressions: 20, ctr: 0.05, position: 10 }] }
  ];
  const client = new GoogleSearchConsoleClient({
    accessToken: "secret-token",
    rowLimit: 2,
    maxRows: 4,
    fetch: async (input, init) => {
      requests.push({ url: String(input), body: JSON.parse(String(init?.body)) as Record<string, unknown>, authorization: new Headers(init?.headers).get("authorization") });
      return Response.json(pages[requests.length - 1]);
    }
  });
  const metrics = await client.fetchPageMetrics("sc-domain:example.com", { startDate: "2026-01-01", endDate: "2026-01-28" });
  assert.equal(metrics.length, 3);
  assert.equal(metrics[0]?.conversions, 0);
  assert.deepEqual(requests.map((request) => request.body.startRow), [0, 2]);
  assert.equal(requests[0]?.authorization, "Bearer secret-token");
  assert.match(requests[0]?.url ?? "", /sc-domain%3Aexample.com/);
});

test("reports actionable GSC errors without leaking the access token", async () => {
  const client = new GoogleSearchConsoleClient({ accessToken: "do-not-leak", fetch: async () => new Response("forbidden", { status: 403 }) });
  await assert.rejects(() => client.fetchPageMetrics("https://example.com/"), (error: unknown) => error instanceof Error && /403.*forbidden/.test(error.message) && !error.message.includes("do-not-leak"));
});

test("refreshes and caches a Google OAuth access token", async () => {
  let calls = 0;
  const provider = new GoogleOAuthTokenProvider({
    clientId: "client",
    clientSecret: "secret",
    refreshToken: "refresh",
    now: () => new Date("2026-08-16T00:00:00Z"),
    fetch: async (_input, init) => {
      calls += 1;
      assert.match(String(init?.body), /grant_type=refresh_token/);
      return Response.json({ access_token: "fresh-access", expires_in: 3600 });
    }
  });
  assert.equal(await provider.getAccessToken(), "fresh-access");
  assert.equal(await provider.getAccessToken(), "fresh-access");
  assert.equal(calls, 1);
});

test("retries a transient OAuth network failure", async () => {
  let calls = 0;
  const provider = new GoogleOAuthTokenProvider({
    clientId: "client",
    clientSecret: "secret",
    refreshToken: "refresh",
    retries: 1,
    retryDelayMs: 0,
    fetch: async () => {
      calls += 1;
      if (calls === 1) throw new TypeError("fetch failed");
      return Response.json({ access_token: "recovered-access", expires_in: 3600 });
    }
  });

  assert.equal(await provider.getAccessToken(), "recovered-access");
  assert.equal(calls, 2);
});

test("retries a transient GSC response without retrying permanent errors", async () => {
  let calls = 0;
  const client = new GoogleSearchConsoleClient({
    accessToken: "secret-token",
    retries: 1,
    retryDelayMs: 0,
    fetch: async () => {
      calls += 1;
      return calls === 1 ? new Response("unavailable", { status: 503 }) : Response.json({ rows: [] });
    }
  });

  assert.deepEqual(await client.fetchPageMetrics("sc-domain:example.com"), []);
  assert.equal(calls, 2);
});
