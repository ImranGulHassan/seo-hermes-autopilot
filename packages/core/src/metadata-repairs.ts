import type { ScanArtifact, WorkspaceConfig } from "./workspace.js";
import { normalizeUrl } from "./util.js";

export interface ReviewedMetadataRepair {
  title?: string;
  description?: string;
  approvedBy: string;
  approvedAt: string;
  note?: string;
}

export function reviewedMetadataRepairs(
  config: WorkspaceConfig,
  artifact: ScanArtifact
): Map<string, ReviewedMetadataRepair> {
  const siteOrigin = new URL(config.siteUrl).origin;
  const indexablePages = artifact.pages.filter((page) => page.indexable);
  const repairs = new Map<string, ReviewedMetadataRepair>();
  const configuredUrls = new Set<string>();

  for (const configured of config.orchestration.metadataRepairs) {
    const url = normalizeUrl(new URL(configured.url, config.siteUrl).toString());
    if (new URL(url).origin !== siteOrigin) {
      throw new Error(`Metadata repair must remain on ${siteOrigin}: ${configured.url}`);
    }
    if (configuredUrls.has(url)) throw new Error(`Duplicate metadata repair for ${configured.url}`);
    configuredUrls.add(url);

    const opportunity = artifact.opportunities.find(
      (item) => item.type === "metadata" && item.affectedUrls.some((affected) => normalizeUrl(affected) === url)
    );
    if (!opportunity) {
      const page = artifact.pages.find((item) => normalizeUrl(item.url) === url);
      const alreadyApplied = page
        && (!configured.title || matchesRenderedTitle(page.title, configured.title))
        && (!configured.description || page.description?.trim() === configured.description.trim());
      if (alreadyApplied) continue;
      throw new Error(`Metadata repair has no current metadata opportunity: ${configured.url}`);
    }
    const issues = Array.isArray(opportunity.evidence.issues)
      ? opportunity.evidence.issues.filter((issue): issue is string => typeof issue === "string")
      : [];
    if (issues.some((issue) => issue.includes("title")) && !configured.title) {
      throw new Error(`Metadata repair must provide a title for ${configured.url}`);
    }
    if (issues.some((issue) => issue.includes("description")) && !configured.description) {
      throw new Error(`Metadata repair must provide a description for ${configured.url}`);
    }

    if (configured.title) assertUnique(configured.title, "title", url, indexablePages);
    if (configured.description) assertUnique(configured.description, "description", url, indexablePages);
    repairs.set(url, {
      ...(configured.title ? { title: configured.title } : {}),
      ...(configured.description ? { description: configured.description } : {}),
      approvedBy: configured.approvedBy,
      approvedAt: configured.approvedAt,
      ...(configured.note ? { note: configured.note } : {})
    });
  }
  return repairs;
}

function matchesRenderedTitle(rendered: string | null, approved: string): boolean {
  if (!rendered) return false;
  const actual = rendered.trim();
  const expected = approved.trim();
  if (actual === expected) return true;
  return [" · ", " | ", " — "].some((separator) => {
    const prefix = `${expected}${separator}`;
    return actual.startsWith(prefix) && actual.length > prefix.length;
  });
}

function assertUnique(
  value: string,
  field: "title" | "description",
  repairedUrl: string,
  pages: ScanArtifact["pages"]
): void {
  const normalized = value.trim().toLocaleLowerCase("en-US");
  const conflict = pages.find(
    (page) => normalizeUrl(page.url) !== repairedUrl && page[field]?.trim().toLocaleLowerCase("en-US") === normalized
  );
  if (conflict) throw new Error(`Reviewed ${field} duplicates ${conflict.url}`);
}
