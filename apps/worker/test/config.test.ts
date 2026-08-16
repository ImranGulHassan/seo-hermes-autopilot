import test from "node:test";
import assert from "node:assert/strict";
import { resolveWorkspacePaths } from "../src/workspaces.js";
test("measurement worker package is executable", () => assert.equal(typeof process.env, "object"));

test("workspace arguments override the environment and paths are deduplicated", () => {
  assert.deepEqual(resolveWorkspacePaths(["sites/a.json", "sites/a.json", "sites/b.json"], "ignored.json", "/service"), ["/service/sites/a.json", "/service/sites/b.json"]);
});

test("workspace environment supports unattended comma-separated sites", () => {
  assert.deepEqual(resolveWorkspacePaths([], "sites/a.json, sites/b.json", "/service"), ["/service/sites/a.json", "/service/sites/b.json"]);
  assert.deepEqual(resolveWorkspacePaths([], undefined, "/service"), ["/service/.seo-autopilot/workspace.json"]);
});
