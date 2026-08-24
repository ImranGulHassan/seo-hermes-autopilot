import test from "node:test";
import assert from "node:assert/strict";
import { ConnectorError, GoogleOAuthTokenProvider, GoogleSearchConsoleClient, completedSearchWindow, createGoogleOAuthState, exchangeGoogleOAuthCode, googleOAuthAuthorizationUrl, verifyGoogleOAuthState, verifySearchConsoleProperty } from "../src/index.js";

test("signs OAuth state, builds the consent URL, and rejects expired state", () => {
  const secret = "x".repeat(32);
  const state = createGoogleOAuthState({ organizationId: "org_1", userId: "user_1", returnTo: "/onboarding?step=gsc", secret, now: new Date("2026-01-01T00:00:00Z"), nonce: "fixed-nonce" });
  assert.equal(verifyGoogleOAuthState(state, secret, new Date("2026-01-01T00:05:00Z")).organizationId, "org_1");
  const url = new URL(googleOAuthAuthorizationUrl({ clientId: "client", redirectUri: "https://app.test/oauth/callback", state }));
  assert.equal(url.searchParams.get("access_type"), "offline");
  assert.match(url.searchParams.get("scope") ?? "", /webmasters\.readonly/);
  assert.throws(() => verifyGoogleOAuthState(state, secret, new Date("2026-01-01T00:11:00Z")), (error: unknown) => error instanceof ConnectorError && error.code === "expired-state");
});

test("exchanges an OAuth code and verifies the selected Search Console property", async () => {
  const tokens = await exchangeGoogleOAuthCode({ clientId: "client", clientSecret: "secret", code: "code", redirectUri: "https://app.test/callback", fetch: async (_input, init) => {
    assert.match(String(init?.body), /grant_type=authorization_code/);
    return Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 3600 });
  } });
  assert.equal(tokens.refresh_token, "refresh");
  const property = await verifySearchConsoleProperty({ accessToken: tokens.access_token, propertyUrl: "sc-domain:example.com", fetch: async () => Response.json({ siteEntry: [{ siteUrl: "sc-domain:example.com", permissionLevel: "siteOwner" }] }) });
  assert.equal(property.writable, true);
});

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
