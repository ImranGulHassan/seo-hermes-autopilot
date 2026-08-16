import test from "node:test";
import assert from "node:assert/strict";
import { ChangeWorkflow, InMemoryChangeLedger, runMeasurementSchedule, type MetricBaseline, type Opportunity } from "../src/index.js";

const baseline: MetricBaseline = { startDate: "2026-01-01", endDate: "2026-01-28", impressions: 1000, clicks: 50, ctr: 0.05, position: 5, conversions: 2, conversionValue: 200, indexed: true };
const opportunity: Opportunity = { id: "opp_schedule", fingerprint: "schedule", type: "metadata", title: "Repair", affectedUrls: ["https://example.com/"], evidence: { issue: "missing" }, confidence: "high", estimatedValue: 1, proposedFix: "Repair", validation: ["build"], approvalPolicy: "required" };

test("scheduler confirms recrawl before evaluating a due window", async () => {
  const ledger = new InMemoryChangeLedger();
  const workflow = new ChangeWorkflow(ledger);
  const change = await workflow.propose({ opportunity, baseline, changedPaths: ["app/page.tsx"], now: new Date("2026-01-01") });
  await workflow.approve(change.id, "reviewer", new Date("2026-01-02"));
  await workflow.markMerged(change.id, "https://github.com/acme/site/pull/1", new Date("2026-01-03"));
  await workflow.markDeployed(change.id, new Date("2026-01-04"));
  const result = await runMeasurementSchedule({
    ledger,
    recrawls: { lastCrawledAt: async () => new Date("2026-01-05") },
    metrics: { observedBaseline: async () => ({ ...baseline, clicks: 70, ctr: 0.07 }) },
    now: new Date("2026-02-03")
  });
  assert.deepEqual(result.recrawled, [change.id]);
  assert.deepEqual(result.evaluated, [{ changeId: change.id, day: 28 }]);
  assert.equal((await ledger.get(change.id))?.evaluations[0]?.outcome, "positive");
});

test("scheduler leaves a deployed change untouched while recrawl is unconfirmed", async () => {
  const ledger = new InMemoryChangeLedger();
  const workflow = new ChangeWorkflow(ledger);
  const change = await workflow.propose({ ...{ opportunity: { ...opportunity, id: "opp_wait", fingerprint: "wait" }, baseline, changedPaths: ["app/page.tsx"] } });
  await workflow.approve(change.id);
  await workflow.markMerged(change.id, "https://github.com/acme/site/pull/2");
  await workflow.markDeployed(change.id);
  const result = await runMeasurementSchedule({ ledger, recrawls: { lastCrawledAt: async () => null }, metrics: { observedBaseline: async () => { throw new Error("must not run"); } } });
  assert.deepEqual(result.waiting, [change.id]);
  assert.equal((await ledger.get(change.id))?.evaluations.length, 0);
});
