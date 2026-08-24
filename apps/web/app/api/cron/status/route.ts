import { NextResponse } from "next/server";
import { PostgresRuntimeJobStore } from "@seo-autopilot/database";
import { authorizeCron } from "../../../../lib/runtime-jobs";
import { onboardingRuntime } from "../../../../lib/onboarding/runtime";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!authorizeCron(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const runtime = await onboardingRuntime();
  return NextResponse.json({ generatedAt: new Date().toISOString(), jobs: await new PostgresRuntimeJobStore(runtime.pool).list() });
}
