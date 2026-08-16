import { evaluateChange } from "./measurement.js";
import type { ChangeLedger } from "./workflow.js";
import { ChangeWorkflow } from "./workflow.js";
import type { ChangeRecord, MetricBaseline } from "./types.js";

export interface RecrawlProvider { lastCrawledAt(url: string): Promise<Date | null> }
export interface EvaluationMetricProvider { observedBaseline(change: ChangeRecord, day: 28 | 56, now: Date): Promise<MetricBaseline | null> }

export interface SchedulerResult { recrawled: string[]; evaluated: Array<{ changeId: string; day: 28 | 56 }>; waiting: string[] }

export async function runMeasurementSchedule(input: {
  ledger: ChangeLedger;
  recrawls: RecrawlProvider;
  metrics: EvaluationMetricProvider;
  now?: Date;
}): Promise<SchedulerResult> {
  const now = input.now ?? new Date();
  const workflow = new ChangeWorkflow(input.ledger);
  const result: SchedulerResult = { recrawled: [], evaluated: [], waiting: [] };
  for (const listed of await input.ledger.list()) {
    if (listed.state !== "deployed") continue;
    let change = listed;
    if (!change.recrawledAt && change.deployedAt) {
      const crawlDates = await Promise.all(change.affectedUrls.map((url) => input.recrawls.lastCrawledAt(url)));
      const confirmed = crawlDates.filter((date): date is Date => Boolean(date)).sort((a, b) => b.getTime() - a.getTime())[0];
      if (confirmed && confirmed.getTime() >= new Date(change.deployedAt).getTime()) {
        change = await workflow.markRecrawled(change.id, confirmed);
        result.recrawled.push(change.id);
      }
    }
    if (!change.recrawledAt) { result.waiting.push(change.id); continue; }
    for (const day of [28, 56] as const) {
      if (change.evaluations.some((evaluation) => evaluation.day === day)) continue;
      if (now.getTime() < new Date(change.recrawledAt).getTime() + day * 86_400_000) continue;
      const observed = await input.metrics.observedBaseline(change, day, now);
      if (!observed) { result.waiting.push(change.id); continue; }
      await evaluateChange(input.ledger, { changeId: change.id, day, observed, now });
      result.evaluated.push({ changeId: change.id, day });
    }
  }
  return result;
}
