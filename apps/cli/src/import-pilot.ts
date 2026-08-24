import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ScanArtifact, WorkspaceConfig } from "@seo-autopilot/core";
import { workspaceConfigSchema } from "@seo-autopilot/core";
import { createPool, migrate, PostgresRunStore, PostgresTenantStore, type Queryable } from "@seo-autopilot/database";
import { z } from "zod";

const artifactSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string().min(1),
  siteUrl: z.string().url(),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime(),
  dataState: z.enum(["technical-only", "search-performance", "analytics-enriched"]),
  pages: z.array(z.unknown()),
  metrics: z.array(z.unknown()),
  errors: z.array(z.unknown()),
  opportunities: z.array(z.unknown())
}).passthrough();

export interface ImportOptions {
  live: boolean;
  organizationId?: string;
  organizationEmail?: string;
  artifactPaths: string[];
  workspacePaths: string[];
}

export interface ImportPlanItem { runId: string; siteUrl: string; }
export interface ImportResult {
  mode: "dry-run" | "live";
  organizationId: string;
  sites: number;
  runs: number;
  alreadyPresent: number;
  items: ImportPlanItem[];
}

export interface PilotImportDependencies {
  resolveOrganization(input: { id?: string; email?: string }): Promise<string>;
  runExists(runId: string): Promise<boolean>;
  claimSite(organizationId: string, siteUrl: string): Promise<void>;
  saveRun(artifact: ScanArtifact): Promise<void>;
}

export function parseImportArgs(args: string[]): ImportOptions {
  const options: ImportOptions = { live: false, artifactPaths: [], workspacePaths: [] };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--live") options.live = true;
    else if (argument === "--organization-id") options.organizationId = requiredValue(args, ++index, argument);
    else if (argument === "--organization-email") options.organizationEmail = requiredValue(args, ++index, argument).toLowerCase();
    else if (argument === "--artifact") options.artifactPaths.push(requiredValue(args, ++index, argument));
    else if (argument === "--workspace") options.workspacePaths.push(requiredValue(args, ++index, argument));
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (Boolean(options.organizationId) === Boolean(options.organizationEmail)) {
    throw new Error("Provide exactly one of --organization-id or --organization-email.");
  }
  if (options.artifactPaths.length + options.workspacePaths.length === 0) {
    throw new Error("Provide at least one --artifact or --workspace input.");
  }
  return options;
}

function requiredValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
  return value;
}

export async function loadImportArtifacts(options: ImportOptions, invocationRoot = process.cwd()): Promise<ScanArtifact[]> {
  const paths = options.artifactPaths.map((path) => resolve(invocationRoot, path));
  for (const workspacePath of options.workspacePaths) {
    const absoluteWorkspacePath = resolve(invocationRoot, workspacePath);
    const workspace = workspaceConfigSchema.parse(JSON.parse(await readFile(absoluteWorkspacePath, "utf8"))) as WorkspaceConfig;
    const artifactPath = resolve(dirname(absoluteWorkspacePath), "latest.json");
    const artifact = artifactSchema.parse(JSON.parse(await readFile(artifactPath, "utf8")));
    if (new URL(artifact.siteUrl).origin !== new URL(workspace.siteUrl).origin) {
      throw new Error(`Workspace and latest artifact site origins do not match for ${workspace.siteUrl}.`);
    }
    paths.push(artifactPath);
  }
  const byRunId = new Map<string, ScanArtifact>();
  for (const path of paths) {
    const artifact = artifactSchema.parse(JSON.parse(await readFile(path, "utf8"))) as unknown as ScanArtifact;
    const existing = byRunId.get(artifact.runId);
    if (existing && JSON.stringify(existing) !== JSON.stringify(artifact)) throw new Error(`Conflicting artifacts use run id ${artifact.runId}.`);
    byRunId.set(artifact.runId, artifact);
  }
  return [...byRunId.values()].sort((left, right) => left.siteUrl.localeCompare(right.siteUrl) || left.runId.localeCompare(right.runId));
}

export async function importPilotData(options: ImportOptions, artifacts: ScanArtifact[], dependencies: PilotImportDependencies): Promise<ImportResult> {
  const organizationId = await dependencies.resolveOrganization({
    ...(options.organizationId ? { id: options.organizationId } : {}),
    ...(options.organizationEmail ? { email: options.organizationEmail } : {})
  });
  const presence = await Promise.all(artifacts.map((artifact) => dependencies.runExists(artifact.runId)));
  const items = artifacts.map(({ runId, siteUrl }) => ({ runId, siteUrl }));
  if (options.live) {
    for (const artifact of artifacts) {
      // Claim first: PostgresTenantStore rejects a site already owned by another tenant.
      await dependencies.claimSite(organizationId, artifact.siteUrl);
      await dependencies.saveRun(artifact);
    }
  }
  return {
    mode: options.live ? "live" : "dry-run",
    organizationId,
    sites: new Set(artifacts.map((artifact) => artifact.siteUrl)).size,
    runs: artifacts.length,
    alreadyPresent: presence.filter(Boolean).length,
    items
  };
}

async function postgresDependencies(database: Queryable): Promise<PilotImportDependencies> {
  const tenants = new PostgresTenantStore(database);
  const runs = new PostgresRunStore(database);
  return {
    async resolveOrganization(input) {
      if (input.id) {
        const found = await database.query<{ id: string }>("SELECT id FROM organizations WHERE id=$1", [input.id]);
        if (found.rowCount !== 1) throw new Error("Organization was not found.");
        return input.id;
      }
      const user = await tenants.findUserByEmail(input.email!);
      if (!user) throw new Error("No user exists for the organization email.");
      const memberships = await tenants.listMemberships(user.id);
      if (memberships.length !== 1) throw new Error("Organization email must resolve to exactly one membership; use --organization-id instead.");
      return memberships[0]!.organizationId;
    },
    async runExists(runId) {
      return (await database.query("SELECT 1 FROM runs WHERE id=$1", [runId])).rowCount === 1;
    },
    async claimSite(organizationId, siteUrl) {
      // Legacy pilot rows predate tenancy. Only NULL ownership may be claimed;
      // PostgresTenantStore.createSite then rejects any cross-tenant conflict.
      await database.query(
        "UPDATE sites SET organization_id=$1 WHERE url=$2 AND organization_id IS NULL",
        [organizationId, siteUrl]
      );
      await tenants.createSite({ organizationId, url: siteUrl });
    },
    async saveRun(artifact) { await runs.save(artifact); }
  };
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const options = parseImportArgs(args);
  const artifacts = await loadImportArtifacts(options, process.env.INIT_CWD ?? process.cwd());
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("DATABASE_URL is required to resolve and import tenant data.");
  const pool = createPool({ connectionString: databaseUrl });
  try {
    // A dry run is read-only, including schema state. Production is migrated only
    // after the operator explicitly supplies --live.
    if (options.live) await migrate(pool);
    const result = await importPilotData(options, artifacts, await postgresDependencies(pool));
    // Deliberately emit only tenant/run identifiers and public site URLs; never configuration or credentials.
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Pilot import failed.");
    process.exitCode = 1;
  });
}
