import type { ChangeRecord, Outcome } from "./types.js";

export interface PilotScorecard {
  proposals: number;
  accepted: number;
  merged: number;
  deployed: number;
  failed: number;
  rejected: number;
  reverted: number;
  acceptanceRate: number | null;
  rollbackRate: number | null;
  outcomes: Record<Outcome, number>;
  gates: {
    acceptance: "passing" | "failing" | "insufficient-data";
    rollback: "passing" | "failing" | "insufficient-data";
    paidConversion: "unavailable";
  };
}

export function calculatePilotScorecard(changes: ChangeRecord[]): PilotScorecard {
  const acceptedStates = new Set(["approved", "merged", "deployed", "reverted"]);
  const mergedStates = new Set(["merged", "deployed", "reverted"]);
  const proposals = changes.filter((change) => Boolean(change.externalPullRequest)).length;
  const accepted = changes.filter((change) => acceptedStates.has(change.state)).length;
  const merged = changes.filter((change) => mergedStates.has(change.state)).length;
  const deployed = changes.filter((change) => ["deployed", "reverted"].includes(change.state)).length;
  const failed = changes.filter((change) => change.state === "failed").length;
  const rejected = changes.filter((change) => change.state === "rejected").length;
  const reverted = changes.filter((change) => change.state === "reverted").length;
  const acceptanceRate = proposals > 0 ? accepted / proposals : null;
  const rollbackRate = merged > 0 ? reverted / merged : null;
  const outcomes: Record<Outcome, number> = { pending: 0, positive: 0, negative: 0, inconclusive: 0, confounded: 0 };
  for (const change of changes.filter((item) => mergedStates.has(item.state))) {
    const latest = [...change.evaluations].sort((a, b) => b.day - a.day)[0];
    outcomes[latest?.outcome ?? "pending"] += 1;
  }
  return {
    proposals, accepted, merged, deployed, failed, rejected, reverted, acceptanceRate, rollbackRate, outcomes,
    gates: {
      acceptance: proposals < 5 ? "insufficient-data" : acceptanceRate! >= 0.4 ? "passing" : "failing",
      rollback: merged < 5 ? "insufficient-data" : rollbackRate! <= 0.05 ? "passing" : "failing",
      paidConversion: "unavailable"
    }
  };
}
