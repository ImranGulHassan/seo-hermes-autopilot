import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync } from "node:crypto";
import { ChangeWorkflow, InMemoryChangeLedger, type MetricBaseline, type Opportunity } from "@seo-autopilot/core";
import { GitHubAppAuthenticator, GitHubAppClient, InMemoryWebhookDeliveryStore, handleGitHubWebhook, reconcileGitHubChanges } from "../src/index.js";

test("mints and caches a GitHub App installation token", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  let calls = 0;
  let authorization = "";
  const authenticator = new GitHubAppAuthenticator({
    appId: 123,
    installationId: 456,
    privateKey,
    now: () => new Date("2026-02-01T00:00:00Z"),
    fetch: async (_input, init) => {
      calls += 1;
      authorization = new Headers(init?.headers).get("authorization") ?? "";
      return Response.json({ token: "installation-token", expires_at: "2026-02-01T01:00:00Z" });
    }
  });
  assert.equal(await authenticator.getAccessToken(), "installation-token");
  assert.equal(await authenticator.getAccessToken(), "installation-token");
  assert.equal(calls, 1);
  assert.match(authorization, /^Bearer [^.]+\.[^.]+\.[^.]+$/);
});

test("creates all file changes as one commit and opens a draft PR", async () => {
  const requests: Array<{ method: string; url: string; body: any; authorization: string | null }> = [];
  let blob = 0;
  const client = new GitHubAppClient({
    installationToken: "installation-secret",
    fetch: async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      requests.push({ method, url, body, authorization: new Headers(init?.headers).get("authorization") });
      if (url.includes("/pulls?")) return Response.json([]);
      if (url.includes("/git/ref/heads/seo-autopilot")) return Response.json({ message: "Not Found" }, { status: 404 });
      if (url.endsWith("/git/ref/heads/main")) return Response.json({ object: { sha: "base-sha" } });
      if (url.endsWith("/git/commits/base-sha")) return Response.json({ tree: { sha: "base-tree" } });
      if (url.includes("/contents/app/page.tsx")) return Response.json({ type: "file", encoding: "base64", content: Buffer.from("old home").toString("base64") });
      if (url.includes("/contents/content/guide.mdx")) return Response.json({ type: "file", encoding: "base64", content: Buffer.from("old guide").toString("base64") });
      if (url.endsWith("/git/blobs")) return Response.json({ sha: `blob-${++blob}` });
      if (url.endsWith("/git/trees")) return Response.json({ sha: "new-tree" });
      if (url.endsWith("/git/commits")) return Response.json({ sha: "new-commit" });
      if (url.endsWith("/git/refs")) return Response.json({ object: { sha: "new-commit" } });
      if (url.endsWith("/pulls")) return Response.json({ number: 7, node_id: "PR_node", html_url: "https://github.com/acme/site/pull/7", head: { ref: "seo-autopilot/opp_123" } });
      return Response.json({ message: "unexpected" }, { status: 500 });
    }
  });
  const result = await client.createDraftPullRequest({
    owner: "acme", repository: "site", baseBranch: "main", headBranch: "seo-autopilot/opp_123",
    title: "[SEO] Repair links", body: "Evidence", commitMessage: "fix(seo): repair links",
    files: [{ filePath: "app/page.tsx", beforeContent: "old home", content: "home" }, { filePath: "content/guide.mdx", beforeContent: "old guide", content: "guide" }]
  });
  assert.equal(result.reused, false);
  assert.equal(requests.filter((request) => request.url.endsWith("/git/commits") && request.method === "POST").length, 1);
  assert.equal(requests.find((request) => request.url.endsWith("/git/trees"))?.body.tree.length, 2);
  assert.equal(requests.find((request) => request.url.endsWith("/pulls") && request.method === "POST")?.body.draft, true);
  assert.equal(requests.every((request) => request.authorization === "Bearer installation-secret"), true);
});

test("reuses an existing open PR without creating Git objects", async () => {
  let requests = 0;
  const client = new GitHubAppClient({ installationToken: "token", fetch: async () => {
    requests += 1;
    return Response.json([{ number: 9, node_id: "PR_existing", html_url: "https://github.com/acme/site/pull/9", head: { ref: "seo-autopilot/opp_existing" } }]);
  } });
  const result = await client.createDraftPullRequest({ owner: "acme", repository: "site", baseBranch: "main", headBranch: "seo-autopilot/opp_existing", title: "Title", body: "Body", commitMessage: "Commit", files: [{ filePath: "app/page.tsx", beforeContent: "old", content: "x" }] });
  assert.equal(result.reused, true);
  assert.equal(requests, 1);
});

test("refuses a PR when a local source file is absent from the remote base", async () => {
  let blobWrites = 0;
  const client = new GitHubAppClient({ installationToken: "token", fetch: async (input, init) => {
    const url = String(input);
    if (url.includes("/pulls?")) return Response.json([]);
    if (url.includes("/git/ref/heads/seo-autopilot")) return Response.json({ message: "Not Found" }, { status: 404 });
    if (url.endsWith("/git/ref/heads/main")) return Response.json({ object: { sha: "base-sha" } });
    if (url.endsWith("/git/commits/base-sha")) return Response.json({ tree: { sha: "base-tree" } });
    if (url.includes("/contents/")) return Response.json({ message: "Not Found" }, { status: 404 });
    if (url.endsWith("/git/blobs") && init?.method === "POST") blobWrites += 1;
    return Response.json({ message: "unexpected" }, { status: 500 });
  } });
  await assert.rejects(() => client.createDraftPullRequest({ owner: "acme", repository: "site", baseBranch: "main", headBranch: "seo-autopilot/opp_missing", title: "Title", body: "Body", commitMessage: "Commit", files: [{ filePath: "content/local.mdx", beforeContent: "local", content: "changed" }] }), /does not exist on GitHub base branch/);
  assert.equal(blobWrites, 0);
});

test("reconciles a missed human merge and production deployment exactly once", async () => {
  const ledger = new InMemoryChangeLedger();
  const workflow = new ChangeWorkflow(ledger);
  const opportunity: Opportunity = { id: "opp_reconcile", fingerprint: "reconcile-fingerprint", type: "broken-link", title: "Repair", affectedUrls: ["https://example.com/a"], evidence: {}, confidence: "high", estimatedValue: 1, proposedFix: "Repair", validation: ["build"], approvalPolicy: "required" };
  const baseline: MetricBaseline = { startDate: "2026-01-01", endDate: "2026-01-28", impressions: 0, clicks: 0, ctr: 0, position: 0, conversions: 0, conversionValue: 0, indexed: true };
  const proposed = await workflow.propose({ opportunity, baseline, changedPaths: ["content/a.mdx"] });
  await workflow.recordPullRequest(proposed.id, { provider: "github", owner: "acme", repository: "site", number: 10, nodeId: "PR_10", headBranch: "seo-autopilot/opp_reconcile" }, "https://github.com/acme/site/pull/10");
  const github = { getPullRequestLifecycle: async () => ({ merged: true, mergedAt: new Date("2026-02-01T10:00:00Z"), mergedBy: "owner", approvedAt: null, approvedBy: null, pullRequestUrl: "https://github.com/acme/site/pull/10", headBranch: "seo-autopilot/opp_reconcile", productionDeployedAt: new Date("2026-02-01T10:05:00Z") }) };
  const first = await reconcileGitHubChanges({ ledger, workflow, github, now: new Date("2026-02-01T10:10:00Z") });
  assert.deepEqual(first.advanced, [{ changeId: proposed.id, actions: ["approved", "merged", "deployed"] }]);
  const updated = await ledger.get(proposed.id);
  assert.equal(updated?.state, "deployed");
  assert.equal(updated?.approvedBy, "github:owner:merge");
  assert.equal(updated?.reconciliations?.length, 1);
  const second = await reconcileGitHubChanges({ ledger, workflow, github, now: new Date("2026-02-01T10:20:00Z") });
  assert.deepEqual(second, { advanced: [], waiting: [], errors: [] });
  assert.equal((await ledger.get(proposed.id))?.reconciliations?.length, 1);
});

test("does not mark a merged change deployed without a production deployment", async () => {
  const ledger = new InMemoryChangeLedger();
  const workflow = new ChangeWorkflow(ledger);
  const opportunity: Opportunity = { id: "opp_wait", fingerprint: "wait-fingerprint", type: "broken-link", title: "Repair", affectedUrls: ["https://example.com/a"], evidence: {}, confidence: "high", estimatedValue: 1, proposedFix: "Repair", validation: ["build"], approvalPolicy: "required" };
  const baseline: MetricBaseline = { startDate: "2026-01-01", endDate: "2026-01-28", impressions: 0, clicks: 0, ctr: 0, position: 0, conversions: 0, conversionValue: 0, indexed: true };
  const proposed = await workflow.propose({ opportunity, baseline, changedPaths: ["content/a.mdx"] });
  await workflow.recordPullRequest(proposed.id, { provider: "github", owner: "acme", repository: "site", number: 11, nodeId: "PR_11", headBranch: "seo-autopilot/opp_wait" }, "https://github.com/acme/site/pull/11");
  const github = { getPullRequestLifecycle: async () => ({ merged: true, mergedAt: new Date("2026-02-01T10:00:00Z"), mergedBy: "owner", approvedAt: null, approvedBy: null, pullRequestUrl: "https://github.com/acme/site/pull/11", headBranch: "seo-autopilot/opp_wait", productionDeployedAt: null }) };
  const result = await reconcileGitHubChanges({ ledger, workflow, github });
  assert.deepEqual(result.advanced[0]?.actions, ["approved", "merged"]);
  assert.equal((await ledger.get(proposed.id))?.state, "merged");
});

test("reconciles a pull request closed without merge as rejected", async () => {
  const ledger = new InMemoryChangeLedger();
  const workflow = new ChangeWorkflow(ledger);
  const opportunity: Opportunity = { id: "opp_rejected", fingerprint: "rejected-fingerprint", type: "broken-link", title: "Repair", affectedUrls: ["https://example.com/a"], evidence: {}, confidence: "high", estimatedValue: 1, proposedFix: "Repair", validation: ["build"], approvalPolicy: "required" };
  const baseline: MetricBaseline = { startDate: "2026-01-01", endDate: "2026-01-28", impressions: 0, clicks: 0, ctr: 0, position: 0, conversions: 0, conversionValue: 0, indexed: true };
  const proposed = await workflow.propose({ opportunity, baseline, changedPaths: ["content/a.mdx"] });
  await workflow.recordPullRequest(proposed.id, { provider: "github", owner: "acme", repository: "site", number: 12, nodeId: "PR_12", headBranch: "seo-autopilot/opp_rejected" }, "https://github.com/acme/site/pull/12");
  const github = { getPullRequestLifecycle: async () => ({ closed: true, closedAt: new Date("2026-02-01T10:00:00Z"), merged: false, mergedAt: null, mergedBy: null, approvedAt: null, approvedBy: null, pullRequestUrl: "https://github.com/acme/site/pull/12", headBranch: "seo-autopilot/opp_rejected", productionDeployedAt: null }) };
  const result = await reconcileGitHubChanges({ ledger, workflow, github });
  assert.deepEqual(result.advanced[0]?.actions, ["rejected"]);
  assert.equal((await ledger.get(proposed.id))?.state, "rejected");
});

test("signed review, merge, and deployment webhooks advance the approval-only ledger exactly once", async () => {
  const ledger = new InMemoryChangeLedger();
  const workflow = new ChangeWorkflow(ledger);
  const opportunity: Opportunity = { id: "opp_1", fingerprint: "fingerprint", type: "metadata", title: "Repair", affectedUrls: ["https://example.com/"], evidence: { issue: "missing" }, confidence: "high", estimatedValue: 1, proposedFix: "Add metadata", validation: ["build"], approvalPolicy: "required" };
  const baseline: MetricBaseline = { startDate: "2026-01-01", endDate: "2026-01-28", impressions: 1000, clicks: 50, ctr: 0.05, position: 5, conversions: 2, conversionValue: 200, indexed: true };
  const change = await workflow.propose({ opportunity, baseline, changedPaths: ["app/page.tsx"] });
  await workflow.recordPullRequest(change.id, { provider: "github", owner: "acme", repository: "site", number: 7, nodeId: "PR_node", headBranch: "seo-autopilot/opp_1" }, "https://github.com/acme/site/pull/7");
  const deliveries = new InMemoryWebhookDeliveryStore();
  const secret = "webhook-secret";
  const send = (event: string, deliveryId: string, payload: unknown) => {
    const rawBody = Buffer.from(JSON.stringify(payload));
    const signature = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
    return handleGitHubWebhook({ event, deliveryId, signature, rawBody, secret, ledger, workflow, deliveries, now: new Date("2026-02-01") });
  };
  const repository = { name: "site", owner: { login: "acme" } };
  const reviewPayload = { action: "submitted", repository, pull_request: { number: 7 }, review: { state: "approved", user: { login: "reviewer" } } };
  assert.deepEqual(await send("pull_request_review", "delivery-1", reviewPayload), { status: "processed", action: "change-approved" });
  assert.deepEqual(await send("pull_request_review", "delivery-1", reviewPayload), { status: "ignored", action: "duplicate-delivery" });
  await send("pull_request", "delivery-2", { action: "closed", repository, pull_request: { number: 7, merged: true, html_url: "https://github.com/acme/site/pull/7" } });
  await send("deployment_status", "delivery-3", { deployment: { ref: "seo-autopilot/opp_1" }, deployment_status: { state: "success" } });
  const updated = await ledger.get(change.id);
  assert.equal(updated?.state, "deployed");
  assert.equal(updated?.approvedBy, "github:reviewer");
});

test("rejects unsigned webhook payloads before recording delivery", async () => {
  const ledger = new InMemoryChangeLedger();
  await assert.rejects(() => handleGitHubWebhook({ event: "ping", deliveryId: "bad", signature: "sha256=bad", rawBody: Buffer.from("{}"), secret: "secret", ledger, workflow: new ChangeWorkflow(ledger), deliveries: new InMemoryWebhookDeliveryStore() }), /Invalid GitHub webhook signature/);
});
