import { readdir, readFile } from "node:fs/promises";
import { extname, relative, resolve, sep } from "node:path";
import type { RepositoryAdapterOptions, SourcePage } from "./types.js";

const ignoredDirectories = new Set([".git", ".next", "node_modules", "dist", "coverage"]);

export async function discoverSourcePages(options: RepositoryAdapterOptions): Promise<SourcePage[]> {
  const root = resolve(options.rootDir);
  const appRoots = [resolve(root, "app"), resolve(root, "src/app")];
  const contentRoots = (options.contentRoots ?? ["content"]).map((path) => resolve(root, path));
  const pages: SourcePage[] = [];
  for (const appRoot of appRoots) {
    for (const filePath of await walkIfPresent(appRoot)) {
      if (!/^page\.(?:tsx|ts|jsx|js)$/.test(filePath.split(sep).at(-1) ?? "")) continue;
      const route = appRoute(appRoot, filePath);
      if (!route) continue;
      const source = await readFile(filePath, "utf8");
      const metadata = parseNextMetadata(source);
      pages.push({ url: new URL(route, ensureTrailingSlash(options.baseUrl)).toString(), route, filePath: relative(root, filePath), kind: "next-app-router", ...metadata });
    }
  }
  for (const contentRoot of contentRoots) {
    for (const filePath of await walkIfPresent(contentRoot)) {
      if (![".md", ".mdx"].includes(extname(filePath))) continue;
      const source = await readFile(filePath, "utf8");
      const frontmatter = parseFrontmatter(source);
      const route = contentRoute(contentRoot, filePath, frontmatter);
      pages.push({ url: new URL(route, ensureTrailingSlash(options.baseUrl)).toString(), route, filePath: relative(root, filePath), kind: "mdx", title: frontmatter.title ?? null, description: frontmatter.description ?? null });
    }
  }
  const unique = new Map<string, SourcePage>();
  const protectedPaths = options.protectedPaths ?? [];
  for (const page of pages.sort((a, b) => a.filePath.localeCompare(b.filePath))) {
    if (protectedPaths.some((pattern) => matchesProtected(page.filePath, page.route, pattern))) continue;
    if (!unique.has(page.url)) unique.set(page.url, page);
  }
  return [...unique.values()];
}

function matchesProtected(filePath: string, route: string, pattern: string): boolean {
  const clean = pattern.replace(/^\//, "").replace(/\/\*\*$/, "").replace(/\/\*$/, "");
  const normalizedFile = filePath.replace(/\\/g, "/");
  const normalizedRoute = route.replace(/^\//, "");
  return normalizedRoute === clean || normalizedRoute.startsWith(`${clean}/`) || normalizedFile.includes(`/${clean}/`);
}

async function walkIfPresent(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) files.push(...await walkIfPresent(path));
      else if (entry.isFile()) files.push(path);
    }
    return files;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function appRoute(appRoot: string, filePath: string): string | null {
  const segments = relative(appRoot, filePath).split(sep).slice(0, -1).filter((segment) => !/^\(.+\)$/.test(segment));
  if (segments.some((segment) => segment.startsWith("[") || segment.startsWith("@"))) return null;
  return `/${segments.join("/")}`.replace(/\/$|^$/, "/");
}

function contentRoute(contentRoot: string, filePath: string, frontmatter: Record<string, string>): string {
  // Canonical/permalink fields express the deployed route. A bare slug often
  // omits the dynamic collection prefix (for example blog/[slug]).
  const explicit = frontmatter.url ?? frontmatter.permalink ?? frontmatter.canonical ?? frontmatter.slug;
  if (explicit) return explicit.startsWith("/") ? explicit : `/${explicit}`;
  const path = relative(contentRoot, filePath).replace(/\\/g, "/").replace(/\.(?:md|mdx)$/, "").replace(/\/index$/, "");
  return `/${path}`;
}

export function parseNextMetadata(source: string): { title: string | null; description: string | null } {
  const block = source.match(/export\s+const\s+metadata(?:\s*:[^=]+)?\s*=\s*\{([\s\S]*?)\}\s*(?:satisfies[^;]+)?;/)?.[1];
  if (!block) return { title: null, description: null };
  return { title: literalProperty(block, "title"), description: literalProperty(block, "description") };
}

function literalProperty(block: string, property: string): string | null {
  const match = block.match(new RegExp(`(?:^|[,\\n])\\s*${property}\\s*:\\s*(["'\\x60])([\\s\\S]*?)\\1`));
  return match?.[2] ?? null;
}

export function parseFrontmatter(source: string): Record<string, string> {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return {};
  return Object.fromEntries((match[1] ?? "").split(/\r?\n/).flatMap((line) => {
    const property = line.match(/^([A-Za-z][\w-]*):\s*(.*?)\s*$/);
    if (!property) return [];
    const value = (property[2] ?? "").replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, "$1$2");
    return [[property[1]!, value]];
  }));
}

function ensureTrailingSlash(value: string): string { return value.endsWith("/") ? value : `${value}/`; }
