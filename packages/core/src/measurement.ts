import type { ChangeLedger } from "./workflow.js";
import type { ChangeRecord, MetricBaseline, Outcome } from "./types.js";

export interface EvaluationInput {
  changeId: string;
  day: 28 | 56;
  observed: MetricBaseline;
  confounded?: boolean;
  now?: Date;
}

export async function evaluateChange(ledger: ChangeLedger, input: EvaluationInput): Promise<ChangeRecord> {
  const change = await ledger.get(input.changeId);
  if (!change || change.state !== "deployed") throw new Error("Only deployed changes can be evaluated.");
  if (!change.recrawledAt) throw new Error("Evaluation waits until Google recrawls the changed page.");
  const anchor = new Date(change.recrawledAt).getTime();
  const now = input.now ?? new Date();
  if (now.getTime() < anchor + input.day * 86_400_000) throw new Error(`Day ${input.day} evaluation window has not elapsed.`);

  let outcome: Outcome;
  let note: string;
  if (input.confounded) {
    outcome = "confounded";
    note = "A site-wide deploy, algorithm update, or other confounder prevents a reliable directional reading.";
  } else if (change.baseline.impressions < 500 || input.observed.impressions < 500) {
    outcome = "inconclusive";
    note = "Insufficient search volume for a directional performance assessment.";
  } else {
    const clickDelta = relativeDelta(change.baseline.clicks, input.observed.clicks);
    const ctrDelta = relativeDelta(change.baseline.ctr, input.observed.ctr);
    const conversionDelta = relativeDelta(change.baseline.conversions, input.observed.conversions);
    const score = clickDelta * 0.5 + ctrDelta * 0.3 + conversionDelta * 0.2;
    outcome = score >= 0.1 ? "positive" : score <= -0.1 ? "negative" : "inconclusive";
    note = `Directional composite delta ${(score * 100).toFixed(1)}%; this is observational, not a causal claim.`;
  }
  change.evaluations = [...change.evaluations.filter((item) => item.day !== input.day), { day: input.day, evaluatedAt: now.toISOString(), outcome, observed: structuredClone(input.observed), note }];
  await ledger.save(change);
  return change;
}

function relativeDelta(before: number, after: number): number {
  if (before === 0) return after === 0 ? 0 : 1;
  return (after - before) / before;
}
