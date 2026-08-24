import test from "node:test";
import assert from "node:assert/strict";
import type { ScanArtifact } from "@seo-autopilot/core";
import { importPilotData, parseImportArgs, type PilotImportDependencies } from "../src/import-pilot.js";

function artifact(runId: string, siteUrl = "https://example.com"): ScanArtifact {
  return {
    schemaVersion: 1, runId, siteUrl,
    startedAt: "2026-08-24T00:00:00.000Z", completedAt: "2026-08-24T00:01:00.000Z",
    dataState: "technical-only", pages: [], metrics: [], errors: [], opportunities: []
  };
}

function dependencies(existing = new Set<string>()) {
  const calls = { claims: [] as string[], saves: [] as string[] };
  const value: PilotImportDependencies = {
    async resolveOrganization(input) {
      assert.deepEqual(input, { id: "org_one" });
      return "org_one";
    },
    async runExists(runId) { return existing.has(runId); },
    async claimSite(_organizationId, siteUrl) { calls.claims.push(siteUrl); },
    async saveRun(value) { calls.saves.push(value.runId); existing.add(value.runId); }
  };
  return { calls, value };
}

test("parses repeatable artifact and workspace inputs and remains dry-run by default", () => {
  assert.deepEqual(parseImportArgs([
    "--organization-email", "OWNER@EXAMPLE.COM", "--artifact", "one.json", "--artifact", "two.json", "--workspace", "site.json"
  ]), {
    live: false,
    organizationEmail: "owner@example.com",
    artifactPaths: ["one.json", "two.json"],
    workspacePaths: ["site.json"]
  });
});

test("rejects ambiguous tenant selectors and missing inputs", () => {
  assert.throws(() => parseImportArgs(["--organization-id", "org", "--organization-email", "a@example.com", "--artifact", "one.json"]), /exactly one/);
  assert.throws(() => parseImportArgs(["--organization-id", "org"]), /at least one/);
});

test("dry-run reports the plan without claiming sites or writing runs", async () => {
  const fake = dependencies(new Set(["run_one"]));
  const result = await importPilotData({ live: false, organizationId: "org_one", artifactPaths: [], workspacePaths: [] }, [artifact("run_one")], fake.value);
  assert.equal(result.mode, "dry-run");
  assert.equal(result.alreadyPresent, 1);
  assert.deepEqual(fake.calls, { claims: [], saves: [] });
});

test("live import claims the tenant before saving and is safe to repeat", async () => {
  const existing = new Set<string>();
  const fake = dependencies(existing);
  const options = { live: true, organizationId: "org_one", artifactPaths: [], workspacePaths: [] };
  const first = await importPilotData(options, [artifact("run_one"), artifact("run_two", "https://second.example")], fake.value);
  const second = await importPilotData(options, [artifact("run_one"), artifact("run_two", "https://second.example")], fake.value);
  assert.equal(first.alreadyPresent, 0);
  assert.equal(second.alreadyPresent, 2);
  assert.deepEqual(fake.calls.saves, ["run_one", "run_two", "run_one", "run_two"]);
  assert.equal(first.sites, 2);
});

test("a tenant ownership conflict stops before a run is saved", async () => {
  const fake = dependencies();
  fake.value.claimSite = async () => { throw new Error("Site belongs to another organization"); };
  await assert.rejects(
    importPilotData({ live: true, organizationId: "org_one", artifactPaths: [], workspacePaths: [] }, [artifact("run_one")], fake.value),
    /another organization/
  );
  assert.deepEqual(fake.calls.saves, []);
});
