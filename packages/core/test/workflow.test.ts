import test from "node:test";
import assert from "node:assert/strict";
import { ChangeWorkflow, InMemoryChangeLedger, WorkflowError, createPullRequestProposal, evaluateChange, runDetectors } from "../src/index.js";
import { baseline, metrics, pages } from "./fixtures.js";

test("requires approval, blocks duplicates, and records the baseline", async () => {
  const opportunity = runDetectors({ pages, metrics })[0]!;
  const ledger = new InMemoryChangeLedger();
  const workflow = new ChangeWorkflow(ledger);
  const change = await workflow.propose({ opportunity, baseline, changedPaths: ["content/guide.mdx"], now: new Date("2026-02-01") });
  assert.deepEqual(change.baseline, baseline);
  await assert.rejects(() => workflow.markMerged(change.id, "https://github.com/acme/site/pull/1"), (error: unknown) => error instanceof WorkflowError && error.code === "APPROVAL_REQUIRED");
  await workflow.approve(change.id);
  const merged = await workflow.markMerged(change.id, "https://github.com/acme/site/pull/1");
  assert.equal(merged.state, "merged");
  await assert.rejects(() => workflow.propose({ opportunity, baseline, changedPaths: [] }), (error: unknown) => error instanceof WorkflowError && error.code === "DUPLICATE");
});

test("protected paths are enforced in code", async () => {
  const opportunity = runDetectors({ pages, metrics })[0]!;
  const workflow = new ChangeWorkflow(new InMemoryChangeLedger());
  await assert.rejects(() => workflow.propose({ opportunity, baseline, changedPaths: ["legal/terms.mdx"] }), (error: unknown) => error instanceof WorkflowError && error.code === "PROTECTED_PATH");
});

test("records an explicit rejection and permits a later corrected proposal", async () => {
  const opportunity = runDetectors({ pages, metrics })[0]!;
  const ledger = new InMemoryChangeLedger();
  const workflow = new ChangeWorkflow(ledger);
  const first = await workflow.propose({ opportunity, baseline, changedPaths: ["content/guide.mdx"] });
  const rejected = await workflow.reject(first.id, "github:owner:closed");
  assert.equal(rejected.state, "rejected");
  assert.equal(rejected.rejectedBy, "github:owner:closed");
  const second = await workflow.propose({ opportunity, baseline, changedPaths: ["content/guide.mdx"], now: new Date("2026-03-01") });
  assert.notEqual(second.id, first.id);
});

test("does not relabel an unpublished internal failure as customer rejection", async () => {
  const opportunity = runDetectors({ pages, metrics })[0]!;
  const ledger = new InMemoryChangeLedger();
  const workflow = new ChangeWorkflow(ledger);
  const change = await workflow.propose({ opportunity, baseline, changedPaths: ["content/guide.mdx"] });
  const failed = (await ledger.get(change.id))!;
  failed.state = "failed";
  await ledger.save(failed);
  await assert.rejects(() => workflow.reject(change.id), /Only an unmerged published change/);
});

test("waits for recrawl and evaluation window, then avoids causal language", async () => {
  const opportunity = runDetectors({ pages, metrics })[0]!;
  const ledger = new InMemoryChangeLedger();
  const workflow = new ChangeWorkflow(ledger);
  const change = await workflow.propose({ opportunity, baseline, changedPaths: ["content/guide.mdx"], now: new Date("2026-01-01") });
  await workflow.approve(change.id);
  await workflow.markMerged(change.id, "https://github.com/acme/site/pull/1", new Date("2026-01-02"));
  await workflow.markDeployed(change.id, new Date("2026-01-03"));
  await workflow.markRecrawled(change.id, new Date("2026-01-05"));
  await assert.rejects(() => evaluateChange(ledger, { changeId: change.id, day: 28, observed: baseline, now: new Date("2026-01-20") }));
  const evaluated = await evaluateChange(ledger, { changeId: change.id, day: 28, observed: { ...baseline, clicks: 75, ctr: 0.075 }, now: new Date("2026-02-03") });
  assert.equal(evaluated.evaluations[0]?.outcome, "positive");
  assert.match(evaluated.evaluations[0]?.note ?? "", /observational, not a causal claim/);
});

test("PR proposal is draft-only and validator-gated", () => {
  const opportunity = runDetectors({ pages, metrics })[0]!;
  assert.throws(() => createPullRequestProposal(opportunity, [{ name: "build", passed: false }]));
  const proposal = createPullRequestProposal(opportunity, [{ name: "build", passed: true }]);
  assert.equal(proposal.draft, true);
  assert.match(proposal.body, /Human approval is required/);
});
