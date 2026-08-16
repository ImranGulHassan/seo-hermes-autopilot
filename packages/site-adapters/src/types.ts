export type SourceKind = "next-app-router" | "mdx";

export interface SourcePage {
  url: string;
  route: string;
  filePath: string;
  kind: SourceKind;
  title: string | null;
  description: string | null;
}

export interface FilePatch {
  filePath: string;
  beforeHash: string;
  before: string;
  after: string;
  reason: string;
}

export interface RepositoryAdapterOptions {
  rootDir: string;
  baseUrl: string;
  contentRoots?: string[];
  protectedPaths?: string[];
}

export interface ValidationCommand {
  name: string;
  command: string;
  args?: string[];
}

export interface PatchValidationResult {
  name: string;
  passed: boolean;
  details: string;
}
