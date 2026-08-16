import type { Opportunity } from "./types.js";

export interface ValidationResult {
  name: string;
  passed: boolean;
  details?: string;
}

export interface PullRequestProposal {
  title: string;
  branch: string;
  body: string;
  draft: true;
}

export function assertValidatorsPassed(results: ValidationResult[]): void {
  const failures = results.filter((result) => !result.passed);
  if (failures.length > 0) throw new Error(`PR blocked by validators: ${failures.map((failure) => failure.name).join(", ")}`);
}

export function createPullRequestProposal(opportunity: Opportunity, results: ValidationResult[]): PullRequestProposal {
  assertValidatorsPassed(results);
  const evidence = Object.entries(opportunity.evidence).map(([key, value]) => `- **${key}:** ${JSON.stringify(value)}`).join("\n");
  const validations = results.map((result) => `- [x] ${result.name}${result.details ? ` — ${result.details}` : ""}`).join("\n");
  return {
    title: `[SEO] ${opportunity.title}`,
    branch: `seo-autopilot/${opportunity.id}`,
    draft: true,
    body: `## Why\n\n${opportunity.proposedFix}\n\n## Evidence\n\n${evidence}\n\n## Expected value\n\n${opportunity.estimatedValue} (${opportunity.confidence} confidence)\n\n## Validation\n\n${validations}\n\n## Measurement\n\n${opportunity.validation.map((item) => `- ${item}`).join("\n")}\n\n> Human approval is required. Outcome reporting is observational and does not claim causality.\n`
  };
}

export function eligibleForDeterministicAutoMerge(records: Array<{ state: string; evaluations: Array<{ outcome: string }> }>): boolean {
  const accepted = records.filter((record) => ["merged", "deployed"].includes(record.state));
  if (accepted.length < 20) return false;
  return accepted.every((record) => record.evaluations.every((evaluation) => evaluation.outcome !== "negative"));
}
