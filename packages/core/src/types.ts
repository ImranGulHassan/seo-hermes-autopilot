import { z } from "zod";

export const pageSnapshotSchema = z.object({
  url: z.string().url(),
  status: z.number().int(),
  title: z.string().nullable(),
  description: z.string().nullable(),
  canonical: z.string().url().nullable(),
  robots: z.array(z.string()),
  sitemapListed: z.boolean(),
  indexable: z.boolean(),
  internalLinks: z.array(z.object({
    href: z.string().url(),
    anchor: z.string(),
    status: z.number().int().optional(),
    redirectTarget: z.string().url().optional()
  })),
  sourcePath: z.string().nullable().default(null),
  sourceState: z.enum(["tracked-clean", "tracked-modified", "untracked"]).nullable().optional()
});

export type PageSnapshot = z.infer<typeof pageSnapshotSchema>;

export const searchMetricSchema = z.object({
  url: z.string().url(),
  impressions: z.number().nonnegative(),
  clicks: z.number().nonnegative(),
  ctr: z.number().min(0).max(1),
  position: z.number().positive(),
  conversions: z.number().nonnegative().default(0),
  conversionValue: z.number().nonnegative().default(0)
});

export type SearchMetric = z.infer<typeof searchMetricSchema>;

export const searchQueryMetricSchema = z.object({
  query: z.string().min(1),
  impressions: z.number().nonnegative(),
  clicks: z.number().nonnegative(),
  ctr: z.number().min(0).max(1),
  position: z.number().positive()
});

export type SearchQueryMetric = z.infer<typeof searchQueryMetricSchema>;

export const detectorTypeSchema = z.enum([
  "broken-link",
  "metadata",
  "under-linked",
  "ctr-anomaly",
  "indexability-conflict"
]);

export type DetectorType = z.infer<typeof detectorTypeSchema>;
export type Confidence = "high" | "medium" | "low";
export type ApprovalPolicy = "required" | "eligible-after-trust-ramp";

export interface Opportunity {
  id: string;
  fingerprint: string;
  type: DetectorType;
  title: string;
  affectedUrls: string[];
  evidence: Record<string, unknown>;
  confidence: Confidence;
  estimatedValue: number;
  proposedFix: string;
  validation: string[];
  approvalPolicy: ApprovalPolicy;
}

export interface ScanInput {
  pages: PageSnapshot[];
  metrics: SearchMetric[];
  sitemapUrls?: string[];
}

export interface DetectorContext extends ScanInput {
  inboundLinkCounts: Map<string, number>;
  metricsByUrl: Map<string, SearchMetric>;
  pagesByUrl: Map<string, PageSnapshot>;
}

export interface Detector {
  type: DetectorType;
  detect(context: DetectorContext): Opportunity[];
}

export interface MetricBaseline {
  startDate: string;
  endDate: string;
  impressions: number;
  clicks: number;
  ctr: number;
  position: number;
  conversions: number;
  conversionValue: number;
  indexed: boolean;
}

export type ChangeState =
  | "proposed"
  | "approved"
  | "merged"
  | "deployed"
  | "failed"
  | "rejected"
  | "reverted";

export type Outcome = "pending" | "positive" | "negative" | "inconclusive" | "confounded";

export interface ChangeRecord {
  id: string;
  opportunityId: string;
  fingerprint: string;
  affectedUrls: string[];
  state: ChangeState;
  approvalRequired: true;
  pullRequestUrl?: string;
  externalPullRequest?: {
    provider: "github";
    owner: string;
    repository: string;
    number: number;
    nodeId: string;
    headBranch: string;
  };
  approvedAt?: string;
  approvedBy?: string;
  baseline: MetricBaseline;
  createdAt: string;
  mergedAt?: string;
  deployedAt?: string;
  rejectedAt?: string;
  rejectedBy?: string;
  recrawledAt?: string;
  evaluations: Array<{
    day: 28 | 56;
    evaluatedAt: string;
    outcome: Outcome;
    observed: MetricBaseline;
    note: string;
  }>;
  reconciliations?: Array<{
    reconciledAt: string;
    source: "github-api";
    actions: string[];
    note: string;
  }>;
}
