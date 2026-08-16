import type { ChangeRecord, MetricBaseline, Opportunity } from "./types.js";
import { stableId } from "./util.js";

export interface ChangeLedger {
  findByFingerprint(fingerprint: string): Promise<ChangeRecord | undefined>;
  get(id: string): Promise<ChangeRecord | undefined>;
  save(record: ChangeRecord): Promise<void>;
  list(): Promise<ChangeRecord[]>;
  findByExternalPullRequest(owner: string, repository: string, number: number): Promise<ChangeRecord | undefined>;
}

export class InMemoryChangeLedger implements ChangeLedger {
  readonly records = new Map<string, ChangeRecord>();
  async findByFingerprint(fingerprint: string) { return [...this.records.values()].find((item) => item.fingerprint === fingerprint); }
  async get(id: string) { return this.records.get(id); }
  async save(record: ChangeRecord) { this.records.set(record.id, structuredClone(record)); }
  async list() { return [...this.records.values()].map((record) => structuredClone(record)); }
  async findByExternalPullRequest(owner: string, repository: string, number: number) {
    return [...this.records.values()].find((item) => item.externalPullRequest?.owner === owner && item.externalPullRequest.repository === repository && item.externalPullRequest.number === number);
  }
}

export interface ProposalInput {
  opportunity: Opportunity;
  baseline: MetricBaseline;
  changedPaths: string[];
  protectedPaths?: string[];
  now?: Date;
}

export class WorkflowError extends Error {
  constructor(readonly code: "DUPLICATE" | "PROTECTED_PATH" | "APPROVAL_REQUIRED" | "INVALID_TRANSITION", message: string) { super(message); }
}

function matchesProtectedPath(path: string, pattern: string): boolean {
  const normalized = path.replace(/^\//, "");
  const normalizedPattern = pattern.replace(/^\//, "");
  if (normalizedPattern.endsWith("/**")) return normalized.startsWith(normalizedPattern.slice(0, -3));
  if (normalizedPattern.endsWith("/*")) return normalized.startsWith(normalizedPattern.slice(0, -1));
  return normalized === normalizedPattern;
}

export class ChangeWorkflow {
  constructor(private readonly ledger: ChangeLedger) {}

  async propose(input: ProposalInput): Promise<ChangeRecord> {
    const existing = await this.ledger.findByFingerprint(input.opportunity.fingerprint);
    if (existing && !["failed", "rejected", "reverted"].includes(existing.state)) throw new WorkflowError("DUPLICATE", `Active change ${existing.id} already covers this opportunity.`);
    const protectedPaths = input.protectedPaths ?? ["legal/**", "pricing", "checkout/**", "auth/**"];
    const blocked = input.changedPaths.find((path) => protectedPaths.some((pattern) => matchesProtectedPath(path, pattern)));
    if (blocked) throw new WorkflowError("PROTECTED_PATH", `${blocked} is protected and cannot be changed.`);
    const now = input.now ?? new Date();
    const id = `chg_${stableId([input.opportunity.fingerprint, now.toISOString()])}`;
    const record: ChangeRecord = {
      id,
      opportunityId: input.opportunity.id,
      fingerprint: input.opportunity.fingerprint,
      affectedUrls: input.opportunity.affectedUrls,
      state: "proposed",
      approvalRequired: true,
      baseline: structuredClone(input.baseline),
      createdAt: now.toISOString(),
      evaluations: []
    };
    await this.ledger.save(record);
    return record;
  }

  async recordPullRequest(id: string, pullRequest: NonNullable<ChangeRecord["externalPullRequest"]>, url: string): Promise<ChangeRecord> {
    const record = await this.require(id);
    if (record.state !== "proposed") throw new WorkflowError("INVALID_TRANSITION", "A pull request can only be attached to a proposed change.");
    if (record.externalPullRequest && (record.externalPullRequest.nodeId !== pullRequest.nodeId || record.externalPullRequest.number !== pullRequest.number)) {
      throw new WorkflowError("DUPLICATE", "This change is already attached to a different pull request.");
    }
    record.externalPullRequest = pullRequest;
    record.pullRequestUrl = url;
    await this.ledger.save(record);
    return record;
  }

  async approve(id: string, identity = "human", now = new Date()): Promise<ChangeRecord> {
    const record = await this.transition(id, "proposed", "approved");
    record.approvedAt = now.toISOString();
    record.approvedBy = identity;
    await this.ledger.save(record);
    return record;
  }

  async markMerged(id: string, pullRequestUrl: string, now = new Date()): Promise<ChangeRecord> {
    const record = await this.require(id);
    if (record.state !== "approved") throw new WorkflowError("APPROVAL_REQUIRED", "A human approval is required before merge.");
    record.state = "merged";
    record.pullRequestUrl = pullRequestUrl;
    record.mergedAt = now.toISOString();
    await this.ledger.save(record);
    return record;
  }

  async reject(id: string, identity = "human", now = new Date()): Promise<ChangeRecord> {
    const record = await this.require(id);
    const failedAfterPublication = record.state === "failed" && Boolean(record.externalPullRequest);
    if (!["proposed", "approved"].includes(record.state) && !failedAfterPublication) throw new WorkflowError("INVALID_TRANSITION", "Only an unmerged published change can be rejected.");
    record.state = "rejected";
    record.rejectedAt = now.toISOString();
    record.rejectedBy = identity;
    await this.ledger.save(record);
    return record;
  }

  async markDeployed(id: string, now = new Date()): Promise<ChangeRecord> {
    const record = await this.require(id);
    if (record.state !== "merged") throw new WorkflowError("INVALID_TRANSITION", "Only a merged change can be deployed.");
    record.state = "deployed";
    record.deployedAt = now.toISOString();
    await this.ledger.save(record);
    return record;
  }

  async markRecrawled(id: string, now = new Date()): Promise<ChangeRecord> {
    const record = await this.require(id);
    if (record.state !== "deployed") throw new WorkflowError("INVALID_TRANSITION", "Only a deployed change can be marked recrawled.");
    record.recrawledAt = now.toISOString();
    await this.ledger.save(record);
    return record;
  }

  private async transition(id: string, from: ChangeRecord["state"], to: ChangeRecord["state"]): Promise<ChangeRecord> {
    const record = await this.require(id);
    if (record.state !== from) throw new WorkflowError("INVALID_TRANSITION", `Expected ${from}, got ${record.state}.`);
    record.state = to;
    await this.ledger.save(record);
    return record;
  }

  private async require(id: string): Promise<ChangeRecord> {
    const record = await this.ledger.get(id);
    if (!record) throw new WorkflowError("INVALID_TRANSITION", `Unknown change ${id}.`);
    return record;
  }
}
