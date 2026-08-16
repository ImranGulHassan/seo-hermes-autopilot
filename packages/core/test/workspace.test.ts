import test from "node:test";
import assert from "node:assert/strict";
import { workspaceConfigSchema } from "../src/index.js";

test("workspace records reviewed destination mappings with approval evidence", () => {
  const config = workspaceConfigSchema.parse({
    version: 1,
    siteUrl: "https://example.com",
    orchestration: {
      maxChanges: 2,
      destinationMappings: [{ from: "/missing", to: "/live", approvedBy: "owner@example.com", approvedAt: "2026-08-16T09:00:00.000Z", note: "Existing navigation hub" }]
    }
  });
  assert.deepEqual(config.orchestration.destinationMappings, [{ from: "/missing", to: "/live", approvedBy: "owner@example.com", approvedAt: "2026-08-16T09:00:00.000Z", note: "Existing navigation hub" }]);
});

test("workspace rejects destination mappings without reviewer evidence", () => {
  assert.throws(() => workspaceConfigSchema.parse({ version: 1, siteUrl: "https://example.com", orchestration: { destinationMappings: [{ from: "/missing", to: "/live" }] } }));
});

test("workspace records PostHog conversion semantics without credentials", () => {
  const config = workspaceConfigSchema.parse({ version: 1, siteUrl: "https://example.com", posthog: { eventName: "resume_downloaded" } });
  assert.deepEqual(config.posthog, { eventName: "resume_downloaded", revenueProperty: "revenue" });
});
