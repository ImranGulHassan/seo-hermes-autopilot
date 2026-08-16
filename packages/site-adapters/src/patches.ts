import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";
import type { FilePatch, SourcePage } from "./types.js";

export async function planMetadataPatch(rootDir: string, page: SourcePage, metadata: { title?: string; description?: string }): Promise<FilePatch | null> {
  if (!metadata.title && !metadata.description) return null;
  validateMetadata(metadata);
  const filePath = resolve(rootDir, page.filePath);
  const before = await readFile(filePath, "utf8");
  const after = page.kind === "mdx" ? updateFrontmatter(before, metadata) : updateNextMetadata(before, metadata);
  if (after === before) return null;
  return makePatch(page.filePath, before, after, `Update metadata for ${page.route}`);
}

export async function planRedirectLinkPatch(rootDir: string, page: SourcePage, fromUrl: string, toUrl: string): Promise<FilePatch | null> {
  const filePath = resolve(rootDir, page.filePath);
  const before = await readFile(filePath, "utf8");
  const from = new URL(fromUrl);
  const to = new URL(toUrl);
  const candidates = new Set([from.toString(), from.pathname + from.search]);
  let after = before;
  let replacements = 0;
  for (const candidate of candidates) {
    const replacement = candidate.startsWith("http") ? to.toString() : to.pathname + to.search;
    after = after.replace(/(?:href\s*=\s*|\]\()(["']?)([^"')\s]+)\1/g, (whole, quote: string, href: string) => {
      if (href !== candidate) return whole;
      replacements += 1;
      return whole.replace(href, replacement);
    });
  }
  if (replacements === 0) return null;
  return makePatch(page.filePath, before, after, `Link directly to ${toUrl} instead of redirecting through ${fromUrl}`);
}

export async function planRepositoryLinkPatches(rootDir: string, fromUrl: string, toUrl: string, searchRoots = ["src", "content"]): Promise<FilePatch[]> {
  const root = resolve(rootDir);
  const files = (await Promise.all(searchRoots.map((searchRoot) => walkSupported(resolve(root, searchRoot))))).flat().sort();
  const from = new URL(fromUrl);
  const to = new URL(toUrl);
  const replacements = new Map([[from.toString(), to.toString()], [from.pathname + from.search, to.pathname + to.search]]);
  const patches: FilePatch[] = [];
  for (const absolutePath of files) {
    const before = await readFile(absolutePath, "utf8");
    const after = replaceStructuredLinks(before, replacements);
    if (after !== before) patches.push(makePatch(relative(root, absolutePath), before, after, `Link directly to ${toUrl} instead of redirecting through ${fromUrl}`));
  }
  return patches;
}

async function walkSupported(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      if (entry.isDirectory() && ["node_modules", ".next", ".git", "dist", "coverage"].includes(entry.name)) continue;
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) files.push(...await walkSupported(path));
      else if (entry.isFile() && [".ts", ".tsx", ".js", ".jsx", ".md", ".mdx"].includes(extname(entry.name))) files.push(path);
    }
    return files;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function replaceStructuredLinks(source: string, replacements: Map<string, string>): string {
  let output = source.replace(/(?:href\s*=\s*|\]\()(["']?)([^"')\s]+)\1/g, (whole, quote: string, value: string) => {
    const replacement = replacements.get(value);
    return replacement ? whole.replace(value, replacement) : whole;
  });
  output = output.replace(/^(\s*(?:parent|relatedContent)\s*:\s*)(.*)$/gm, (_whole, prefix: string, value: string) => {
    let updated = value;
    for (const [from, to] of replacements) updated = updated.replace(new RegExp(`(["'])${escapeRegExp(from)}\\1`, "g"), (quoted) => quoted.replace(from, to));
    return `${prefix}${updated}`;
  });
  return output;
}

function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function updateFrontmatter(source: string, metadata: { title?: string; description?: string }): string {
  const match = source.match(/^(---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))/);
  let body = match?.[2] ?? "";
  for (const [key, value] of Object.entries(metadata)) {
    if (!value) continue;
    const line = `${key}: ${JSON.stringify(value)}`;
    const expression = new RegExp(`^${key}:.*$`, "m");
    body = expression.test(body) ? body.replace(expression, line) : `${body}${body ? "\n" : ""}${line}`;
  }
  if (!match) return `---\n${body}\n---\n${source}`;
  return `${match[1]}${body}${match[3]}${source.slice(match[0].length)}`;
}

function updateNextMetadata(source: string, metadata: { title?: string; description?: string }): string {
  if (/export\s+(?:async\s+)?function\s+generateMetadata/.test(source)) throw new Error("Dynamic generateMetadata is intentionally unsupported.");
  const blockExpression = /export\s+const\s+metadata(?:\s*:[^=]+)?\s*=\s*\{([\s\S]*?)\}\s*(?:satisfies[^;]+)?;/;
  const block = source.match(blockExpression);
  if (!block) {
    const properties = Object.entries(metadata).filter((entry): entry is [string, string] => Boolean(entry[1])).map(([key, value]) => `  ${key}: ${JSON.stringify(value)},`).join("\n");
    return `export const metadata = {\n${properties}\n};\n\n${source}`;
  }
  let contents = block[1] ?? "";
  for (const [key, value] of Object.entries(metadata)) {
    if (!value) continue;
    const property = new RegExp(`((?:^|[,\\n])\\s*${key}\\s*:\\s*)(["'\\x60])([\\s\\S]*?)\\2`);
    if (property.test(contents)) contents = contents.replace(property, `$1${JSON.stringify(value)}`);
    else contents = `${contents.trimEnd()}\n  ${key}: ${JSON.stringify(value)},\n`;
  }
  return source.replace(blockExpression, (whole) => whole.replace(block[1] ?? "", contents));
}

function validateMetadata(metadata: { title?: string; description?: string }): void {
  if (metadata.title && (metadata.title.length < 10 || metadata.title.length > 120)) throw new Error("Title must contain 10–120 characters.");
  if (metadata.description && (metadata.description.length < 40 || metadata.description.length > 300)) throw new Error("Description must contain 40–300 characters.");
}

function makePatch(filePath: string, before: string, after: string, reason: string): FilePatch {
  return { filePath, before, after, beforeHash: createHash("sha256").update(before).digest("hex"), reason };
}
