import { resolve } from "node:path";

export function resolveWorkspacePaths(args: string[], configured: string | undefined, root: string): string[] {
  const values = args.length > 0 ? args : configured?.split(",").map((value) => value.trim()).filter(Boolean) ?? [".seo-autopilot/workspace.json"];
  return [...new Set(values.map((value) => resolve(root, value)))];
}
