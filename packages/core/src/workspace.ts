import { z } from "zod";

export const workspaceConfigSchema = z.object({
  version: z.literal(1),
  siteUrl: z.string().url(),
  gscPropertyUrl: z.string().min(1).optional(),
  posthog: z.object({
    eventName: z.string().min(1),
    revenueProperty: z.string().min(1).default("revenue")
  }).optional(),
  protectedPaths: z.array(z.string()).default(["legal/**", "pricing", "checkout/**", "auth/**"]),
  crawl: z.object({
    maxPages: z.number().int().positive().max(10_000).default(500),
    concurrency: z.number().int().positive().max(20).default(4)
  }).default({ maxPages: 500, concurrency: 4 }),
  repository: z.object({
    rootDir: z.string().min(1),
    frameworkRoot: z.string().min(1).default("."),
    contentRoots: z.array(z.string()).default(["content"]),
    validators: z.array(z.object({
      name: z.string().min(1),
      command: z.string().min(1),
      args: z.array(z.string()).default([])
    })).default([])
  }).optional(),
  github: z.object({
    owner: z.string().min(1),
    repository: z.string().min(1),
    baseBranch: z.string().min(1).default("main")
  }).optional(),
  orchestration: z.object({
    maxChanges: z.number().int().positive().max(20).default(5),
    destinationMappings: z.array(z.object({
      from: z.string().min(1),
      to: z.string().min(1),
      approvedBy: z.string().min(1),
      approvedAt: z.string().datetime(),
      note: z.string().min(1).optional()
    })).default([]),
    metadataRepairs: z.array(z.object({
      url: z.string().min(1),
      title: z.string().min(10).max(120).optional(),
      description: z.string().min(40).max(300).optional(),
      approvedBy: z.string().min(1),
      approvedAt: z.string().datetime(),
      note: z.string().min(1).optional()
    }).refine((repair) => Boolean(repair.title || repair.description), {
      message: "A metadata repair must provide a title or description."
    })).default([])
  }).default({ maxChanges: 5 })
});

export type WorkspaceConfig = z.infer<typeof workspaceConfigSchema>;

export interface ScanArtifact {
  schemaVersion: 1;
  runId: string;
  startedAt: string;
  completedAt: string;
  siteUrl: string;
  dataState: "technical-only" | "search-performance" | "analytics-enriched";
  analyticsState?: "not-configured" | "enriched" | "unavailable";
  metricWindow?: { startDate: string; endDate: string };
  pages: import("./types.js").PageSnapshot[];
  metrics: import("./types.js").SearchMetric[];
  queryMetrics?: import("./types.js").SearchQueryMetric[];
  sitemapUrls?: string[];
  errors: Array<{ source: "crawler" | "gsc" | "posthog" | "repository"; message: string; url?: string }>;
  opportunities: import("./types.js").Opportunity[];
}
