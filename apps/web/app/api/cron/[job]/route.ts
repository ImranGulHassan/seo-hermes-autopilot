import { NextResponse } from "next/server";
import { authorizeCron, executeRuntimeJob } from "../../../../lib/runtime-jobs";
import type { RuntimeJobName } from "@seo-autopilot/database";

export const dynamic = "force-dynamic";
export const maxDuration = 300;
const jobs = new Set<RuntimeJobName>(["daily-scan", "github-reconcile", "measurement"]);

export async function GET(request: Request, context: { params: Promise<{ job: string }> }) {
  if (!authorizeCron(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { job } = await context.params;
  if (!jobs.has(job as RuntimeJobName)) return NextResponse.json({ error: "Unknown job" }, { status: 404 });
  try { return NextResponse.json(await executeRuntimeJob(job as RuntimeJobName)); }
  catch (error) { return NextResponse.json({ status: "failed", error: error instanceof Error ? error.message : String(error) }, { status: 500 }); }
}
