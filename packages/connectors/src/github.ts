import { createHmac, createSign, timingSafeEqual } from "node:crypto";
import type { ChangeLedger, ChangeWorkflow } from "@seo-autopilot/core";
import { z } from "zod";

export interface GitHubFileChange { filePath: string; beforeContent: string; content: string }

export interface DraftPullRequestInput {
  owner: string;
  repository: string;
  baseBranch: string;
  headBranch: string;
  title: string;
  body: string;
  commitMessage: string;
  files: GitHubFileChange[];
}

export interface DraftPullRequestResult {
  number: number;
  nodeId: string;
  url: string;
  headBranch: string;
  reused: boolean;
}

export interface GitHubClientOptions {
  installationToken?: string;
  tokenProvider?: { getAccessToken(): Promise<string> };
  fetch?: typeof globalThis.fetch;
  apiBaseUrl?: string;
}

const refSchema = z.object({ object: z.object({ sha: z.string() }) });
const commitSchema = z.object({ tree: z.object({ sha: z.string() }) });
const shaSchema = z.object({ sha: z.string() });
const pullSchema = z.object({ number: z.number().int(), node_id: z.string(), html_url: z.string().url(), head: z.object({ ref: z.string() }) });
const contentSchema = z.object({ type: z.literal("file"), encoding: z.literal("base64"), content: z.string() });
const lifecyclePullSchema = z.object({
  state: z.string(), closed_at: z.string().datetime().nullable(), merged: z.boolean(), merged_at: z.string().datetime().nullable(), merge_commit_sha: z.string().nullable(), html_url: z.string().url(),
  merged_by: z.object({ login: z.string() }).nullable(), head: z.object({ ref: z.string() })
});
const reviewSchema = z.object({ state: z.string(), submitted_at: z.string().datetime().nullable(), user: z.object({ login: z.string() }).nullable() });
const deploymentSchema = z.object({ id: z.number().int(), sha: z.string(), environment: z.string(), created_at: z.string().datetime() });
const deploymentStatusSchema = z.object({ state: z.string(), created_at: z.string().datetime() });
const comparisonSchema = z.object({ status: z.enum(["ahead", "behind", "diverged", "identical"]) });

export interface GitHubPullRequestLifecycle {
  closed?: boolean;
  closedAt?: Date | null;
  merged: boolean;
  mergedAt: Date | null;
  mergedBy: string | null;
  approvedAt: Date | null;
  approvedBy: string | null;
  pullRequestUrl: string;
  headBranch: string;
  productionDeployedAt: Date | null;
}

export interface GitHubLifecycleProvider { getPullRequestLifecycle(owner: string, repository: string, number: number): Promise<GitHubPullRequestLifecycle> }

export class GitHubAppClient {
  private readonly fetcher: typeof globalThis.fetch;
  private readonly apiBaseUrl: string;

  constructor(private readonly options: GitHubClientOptions) {
    if (Boolean(options.installationToken?.trim()) === Boolean(options.tokenProvider)) throw new Error("Provide exactly one GitHub installation token or token provider.");
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.apiBaseUrl = (options.apiBaseUrl ?? "https://api.github.com").replace(/\/$/, "");
  }

  async createDraftPullRequest(input: DraftPullRequestInput): Promise<DraftPullRequestResult> {
    if (input.files.length === 0) throw new Error("At least one changed file is required.");
    if (!/^seo-autopilot\/[a-zA-Z0-9._/-]+$/.test(input.headBranch)) throw new Error("SEO branches must use the seo-autopilot/ prefix.");
    const repositoryPath = `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}`;
    const existing = z.array(pullSchema).parse(await this.request(`${repositoryPath}/pulls?state=open&head=${encodeURIComponent(`${input.owner}:${input.headBranch}`)}`));
    if (existing[0]) return toResult(existing[0], true);

    const headRef = await this.optionalRequest(`${repositoryPath}/git/ref/heads/${encodeURIComponent(input.headBranch)}`);
    if (headRef) throw new Error(`GitHub branch ${input.headBranch} already exists without an open pull request; refusing to reuse unknown branch content.`);
    {
      const baseRef = refSchema.parse(await this.request(`${repositoryPath}/git/ref/heads/${encodeURIComponent(input.baseBranch)}`));
      const baseCommit = commitSchema.parse(await this.request(`${repositoryPath}/git/commits/${baseRef.object.sha}`));
      const treeEntries = [];
      for (const file of input.files) {
        const remote = await this.optionalRequest(`${repositoryPath}/contents/${cleanRepositoryPath(file.filePath).split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(input.baseBranch)}`);
        if (!remote) throw new Error(`${file.filePath} does not exist on GitHub base branch ${input.baseBranch}; refusing to create an addition from an untracked local file.`);
        const current = contentSchema.parse(remote);
        const remoteContent = Buffer.from(current.content.replace(/\s/g, ""), "base64").toString("utf8");
        if (remoteContent !== file.beforeContent) throw new Error(`${file.filePath} differs from GitHub base branch ${input.baseBranch}; refresh the local repository before proposing a PR.`);
        const blob = shaSchema.parse(await this.request(`${repositoryPath}/git/blobs`, { method: "POST", body: JSON.stringify({ content: file.content, encoding: "utf-8" }) }));
        treeEntries.push({ path: cleanRepositoryPath(file.filePath), mode: "100644", type: "blob", sha: blob.sha });
      }
      const tree = shaSchema.parse(await this.request(`${repositoryPath}/git/trees`, { method: "POST", body: JSON.stringify({ base_tree: baseCommit.tree.sha, tree: treeEntries }) }));
      const commit = shaSchema.parse(await this.request(`${repositoryPath}/git/commits`, { method: "POST", body: JSON.stringify({ message: input.commitMessage, tree: tree.sha, parents: [baseRef.object.sha] }) }));
      await this.request(`${repositoryPath}/git/refs`, { method: "POST", body: JSON.stringify({ ref: `refs/heads/${input.headBranch}`, sha: commit.sha }) });
    }
    const pull = pullSchema.parse(await this.request(`${repositoryPath}/pulls`, {
      method: "POST",
      body: JSON.stringify({ title: input.title, body: input.body, head: input.headBranch, base: input.baseBranch, draft: true, maintainer_can_modify: false })
    }));
    return toResult(pull, false);
  }

  async getPullRequestLifecycle(owner: string, repository: string, number: number): Promise<GitHubPullRequestLifecycle> {
    const repositoryPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`;
    const pull = lifecyclePullSchema.parse(await this.request(`${repositoryPath}/pulls/${number}`));
    const reviews = z.array(reviewSchema).parse(await this.request(`${repositoryPath}/pulls/${number}/reviews`));
    const approvals = reviews.filter((review) => review.state.toLowerCase() === "approved" && review.submitted_at).sort((a, b) => String(a.submitted_at).localeCompare(String(b.submitted_at)));
    const approval = approvals.at(-1);
    let productionDeployedAt: Date | null = null;
    if (pull.merge_commit_sha) {
      const exact = z.array(deploymentSchema).parse(await this.request(`${repositoryPath}/deployments?sha=${encodeURIComponent(pull.merge_commit_sha)}&environment=Production&per_page=20`));
      const deployments = exact.length > 0
        ? exact
        : z.array(deploymentSchema).parse(await this.request(`${repositoryPath}/deployments?environment=Production&per_page=20`));
      for (const deployment of deployments) {
        if (pull.merged_at && new Date(deployment.created_at) < new Date(pull.merged_at)) continue;
        if (deployment.sha !== pull.merge_commit_sha) {
          const comparison = comparisonSchema.parse(await this.request(`${repositoryPath}/compare/${encodeURIComponent(pull.merge_commit_sha)}...${encodeURIComponent(deployment.sha)}`));
          if (!['ahead', 'identical'].includes(comparison.status)) continue;
        }
        const statuses = z.array(deploymentStatusSchema).parse(await this.request(`${repositoryPath}/deployments/${deployment.id}/statuses?per_page=20`));
        const success = statuses.filter((status) => status.state.toLowerCase() === "success").sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
        if (success && (!productionDeployedAt || new Date(success.created_at) > productionDeployedAt)) productionDeployedAt = new Date(success.created_at);
      }
    }
    return {
      closed: pull.state.toLowerCase() === "closed",
      closedAt: pull.closed_at ? new Date(pull.closed_at) : null,
      merged: pull.merged,
      mergedAt: pull.merged_at ? new Date(pull.merged_at) : null,
      mergedBy: pull.merged_by?.login ?? null,
      approvedAt: approval?.submitted_at ? new Date(approval.submitted_at) : null,
      approvedBy: approval?.user?.login ?? null,
      pullRequestUrl: pull.html_url,
      headBranch: pull.head.ref,
      productionDeployedAt
    };
  }

  private async optionalRequest(path: string): Promise<unknown | null> {
    const response = await this.raw(path);
    if (response.status === 404) return null;
    if (!response.ok) throw await githubError(response);
    return response.json();
  }

  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    const response = await this.raw(path, init);
    if (!response.ok) throw await githubError(response);
    return response.status === 204 ? null : response.json();
  }

  private async raw(path: string, init: RequestInit = {}): Promise<Response> {
    const token = this.options.tokenProvider ? await this.options.tokenProvider.getAccessToken() : this.options.installationToken!;
    return this.fetcher(`${this.apiBaseUrl}${path}`, {
      ...init,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
        ...init.headers
      }
    });
  }
}

export async function reconcileGitHubChanges(input: { ledger: ChangeLedger; workflow: ChangeWorkflow; github: GitHubLifecycleProvider; now?: Date }): Promise<{ advanced: Array<{ changeId: string; actions: string[] }>; waiting: string[]; errors: Array<{ changeId: string; error: string }> }> {
  const result: { advanced: Array<{ changeId: string; actions: string[] }>; waiting: string[]; errors: Array<{ changeId: string; error: string }> } = { advanced: [], waiting: [], errors: [] };
  for (const listed of await input.ledger.list()) {
    if (!["proposed", "approved", "merged", "failed"].includes(listed.state) || !listed.externalPullRequest) continue;
    try {
      const pr = listed.externalPullRequest;
      const lifecycle = await input.github.getPullRequestLifecycle(pr.owner, pr.repository, pr.number);
      const actions: string[] = [];
      let change = listed;
      if (["proposed", "approved", "failed"].includes(change.state) && lifecycle.closed && !lifecycle.merged) {
        change = await input.workflow.reject(change.id, "github:closed-without-merge", lifecycle.closedAt ?? input.now ?? new Date());
        actions.push("rejected");
      }
      if (change.state === "proposed" && (lifecycle.approvedAt || lifecycle.merged)) {
        const time = lifecycle.approvedAt ?? lifecycle.mergedAt ?? input.now ?? new Date();
        const identity = lifecycle.approvedBy ?? lifecycle.mergedBy ?? "unknown";
        change = await input.workflow.approve(change.id, `github:${identity}:${lifecycle.merged ? "merge" : "review"}`, time);
        actions.push("approved");
      }
      if (change.state === "approved" && lifecycle.merged && lifecycle.mergedAt) {
        change = await input.workflow.markMerged(change.id, lifecycle.pullRequestUrl, lifecycle.mergedAt);
        actions.push("merged");
      }
      if (change.state === "merged" && lifecycle.productionDeployedAt && (!change.mergedAt || lifecycle.productionDeployedAt >= new Date(change.mergedAt))) {
        change = await input.workflow.markDeployed(change.id, lifecycle.productionDeployedAt);
        actions.push("deployed");
      }
      if (actions.length === 0) { result.waiting.push(change.id); continue; }
      const fresh = (await input.ledger.get(change.id))!;
      fresh.reconciliations = [...(fresh.reconciliations ?? []), { reconciledAt: (input.now ?? new Date()).toISOString(), source: "github-api", actions, note: "Recovered lifecycle state from authoritative GitHub API after delayed or missed webhook delivery." }];
      await input.ledger.save(fresh);
      result.advanced.push({ changeId: change.id, actions });
    } catch (error) { result.errors.push({ changeId: listed.id, error: error instanceof Error ? error.message : String(error) }); }
  }
  return result;
}

const installationTokenSchema = z.object({ token: z.string().min(1), expires_at: z.string().datetime() });

export interface GitHubAppAuthenticatorOptions {
  appId: string | number;
  installationId: string | number;
  privateKey: string;
  fetch?: typeof globalThis.fetch;
  apiBaseUrl?: string;
  now?: () => Date;
}

export class GitHubAppAuthenticator {
  private cached?: { token: string; expiresAt: number };
  private readonly fetcher: typeof globalThis.fetch;
  private readonly apiBaseUrl: string;
  private readonly now: () => Date;

  constructor(private readonly options: GitHubAppAuthenticatorOptions) {
    if (!String(options.appId).trim() || !String(options.installationId).trim() || !options.privateKey.trim()) throw new Error("GitHub App ID, installation ID, and private key are required.");
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.apiBaseUrl = (options.apiBaseUrl ?? "https://api.github.com").replace(/\/$/, "");
    this.now = options.now ?? (() => new Date());
  }

  async getAccessToken(): Promise<string> {
    const now = this.now().getTime();
    if (this.cached && this.cached.expiresAt - now > 60_000) return this.cached.token;
    const jwt = createAppJwt(this.options.appId, this.options.privateKey, this.now());
    const response = await this.fetcher(`${this.apiBaseUrl}/app/installations/${encodeURIComponent(String(this.options.installationId))}/access_tokens`, {
      method: "POST",
      headers: { accept: "application/vnd.github+json", authorization: `Bearer ${jwt}`, "content-type": "application/json", "x-github-api-version": "2022-11-28" }
    });
    if (!response.ok) throw await githubError(response);
    const token = installationTokenSchema.parse(await response.json());
    this.cached = { token: token.token, expiresAt: new Date(token.expires_at).getTime() };
    return token.token;
  }
}

function createAppJwt(appId: string | number, privateKey: string, now: Date): string {
  const issuedAt = Math.floor(now.getTime() / 1000) - 60;
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64Url(JSON.stringify({ iat: issuedAt, exp: issuedAt + 9 * 60, iss: String(appId) }));
  const unsigned = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  return `${unsigned}.${signer.sign(privateKey).toString("base64url")}`;
}

function base64Url(value: string): string { return Buffer.from(value).toString("base64url"); }

function cleanRepositoryPath(path: string): string {
  const clean = path.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!clean || clean.startsWith("/") || clean.startsWith("../") || clean.includes("/../")) throw new Error(`Invalid repository path: ${path}`);
  return clean;
}

function toResult(pull: z.infer<typeof pullSchema>, reused: boolean): DraftPullRequestResult {
  return { number: pull.number, nodeId: pull.node_id, url: pull.html_url, headBranch: pull.head.ref, reused };
}

async function githubError(response: Response): Promise<Error> {
  const detail = (await response.text()).slice(0, 1_000);
  return new Error(`GitHub API request failed (${response.status}): ${detail || response.statusText}`);
}

export function verifyGitHubWebhook(rawBody: Uint8Array, signature: string | null, secret: string): boolean {
  if (!signature?.startsWith("sha256=") || !secret) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  const receivedBytes = Buffer.from(signature);
  const expectedBytes = Buffer.from(expected);
  return receivedBytes.length === expectedBytes.length && timingSafeEqual(receivedBytes, expectedBytes);
}

export interface WebhookDeliveryStore {
  has(deliveryId: string): Promise<boolean>;
  add(deliveryId: string): Promise<void>;
}

export class InMemoryWebhookDeliveryStore implements WebhookDeliveryStore {
  private readonly deliveries = new Set<string>();
  async has(deliveryId: string) { return this.deliveries.has(deliveryId); }
  async add(deliveryId: string) { this.deliveries.add(deliveryId); }
}

export interface HandleWebhookInput {
  event: string;
  deliveryId: string;
  signature: string | null;
  rawBody: Uint8Array;
  secret: string;
  ledger: ChangeLedger;
  workflow: ChangeWorkflow;
  deliveries: WebhookDeliveryStore;
  now?: Date;
}

export async function handleGitHubWebhook(input: HandleWebhookInput): Promise<{ status: "processed" | "ignored"; action?: string }> {
  if (!verifyGitHubWebhook(input.rawBody, input.signature, input.secret)) throw new Error("Invalid GitHub webhook signature.");
  if (await input.deliveries.has(input.deliveryId)) return { status: "ignored", action: "duplicate-delivery" };
  const payload = JSON.parse(Buffer.from(input.rawBody).toString("utf8")) as Record<string, any>;
  let action: string | undefined;
  if (input.event === "pull_request_review" && payload.action === "submitted" && payload.review?.state?.toLowerCase() === "approved") {
    const change = await findPullRequestChange(input.ledger, payload);
    if (change?.state === "proposed") {
      await input.workflow.approve(change.id, `github:${String(payload.review.user?.login ?? "unknown")}`, input.now);
      action = "change-approved";
    }
  } else if (input.event === "pull_request" && payload.action === "closed" && payload.pull_request?.merged === true) {
    const change = await findPullRequestChange(input.ledger, payload);
    if (change?.state === "approved") {
      await input.workflow.markMerged(change.id, String(payload.pull_request.html_url), input.now);
      action = "change-merged";
    }
  } else if (input.event === "pull_request" && payload.action === "closed" && payload.pull_request?.merged === false) {
    const change = await findPullRequestChange(input.ledger, payload);
    if (change && ["proposed", "approved"].includes(change.state)) {
      await input.workflow.reject(change.id, `github:${String(payload.sender?.login ?? "unknown")}:closed`, input.now);
      action = "change-rejected";
    }
  } else if (input.event === "deployment_status" && payload.deployment_status?.state === "success") {
    const branch = String(payload.deployment?.ref ?? "");
    const change = (await input.ledger.list()).find((item) => item.state === "merged" && item.externalPullRequest?.headBranch === branch);
    if (change) {
      await input.workflow.markDeployed(change.id, input.now);
      action = "change-deployed";
    }
  }
  await input.deliveries.add(input.deliveryId);
  return action ? { status: "processed", action } : { status: "ignored" };
}

async function findPullRequestChange(ledger: ChangeLedger, payload: Record<string, any>) {
  const owner = String(payload.repository?.owner?.login ?? "");
  const repository = String(payload.repository?.name ?? "");
  const number = Number(payload.pull_request?.number ?? payload.number);
  if (!owner || !repository || !Number.isInteger(number)) return undefined;
  return ledger.findByExternalPullRequest(owner, repository, number);
}
