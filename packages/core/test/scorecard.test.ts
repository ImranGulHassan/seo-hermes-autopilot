import test from "node:test";
import assert from "node:assert/strict";
import { calculatePilotScorecard, type ChangeRecord } from "../src/index.js";

function change(id: string, state: ChangeRecord["state"], outcome?: "positive" | "negative"): ChangeRecord {
  return {
    id, opportunityId: `opp_${id}`, fingerprint: id, affectedUrls: ["https://example.com"], state, approvalRequired: true,
    externalPullRequest: { provider: "github", owner: "acme", repository: "site", number: Number(id), nodeId: `PR_${id}`, headBranch: `seo-autopilot/${id}` },
    baseline: { startDate: "2026-01-01", endDate: "2026-01-28", impressions: 100, clicks: 10, ctr: 0.1, position: 5, conversions: 1, conversionValue: 10, indexed: true },
    createdAt: "2026-01-29T00:00:00.000Z",
    evaluations: outcome ? [{ day: 28, evaluatedAt: "2026-02-28T00:00:00.000Z", outcome, observed: { startDate: "2026-02-01", endDate: "2026-02-28", impressions: 110, clicks: 12, ctr: 12 / 110, position: 4.8, conversions: 1, conversionValue: 10, indexed: true }, note: "Observational." }] : []
  };
}

test("pilot scorecard calculates acceptance, rollback, and latest outcomes", () => {
  const scorecard = calculatePilotScorecard([change("1", "deployed", "positive"), change("2", "reverted", "negative"), change("3", "proposed"), change("4", "approved"), change("5", "failed")]);
  assert.equal(scorecard.accepted, 3);
  assert.equal(scorecard.acceptanceRate, 0.6);
  assert.equal(scorecard.rollbackRate, 0.5);
  assert.equal(scorecard.outcomes.positive, 1);
  assert.equal(scorecard.outcomes.pending, 0);
  assert.equal(scorecard.gates.acceptance, "passing");
  assert.equal(scorecard.gates.rollback, "insufficient-data");
  assert.equal(scorecard.gates.paidConversion, "unavailable");
});

test("internal failures are excluded from the opened-PR acceptance denominator", () => {
  const failed = change("1", "failed");
  delete failed.externalPullRequest;
  const rejected = change("2", "rejected");
  const scorecard = calculatePilotScorecard([failed, rejected]);
  assert.equal(scorecard.proposals, 1);
  assert.equal(scorecard.rejected, 1);
  assert.equal(scorecard.acceptanceRate, 0);
});

test("empty scorecard avoids misleading zero-percent rates", () => {
  const scorecard = calculatePilotScorecard([]);
  assert.equal(scorecard.acceptanceRate, null);
  assert.equal(scorecard.rollbackRate, null);
  assert.equal(scorecard.gates.acceptance, "insufficient-data");
});
