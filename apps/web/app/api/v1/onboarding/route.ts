import { isResponse, onboardingOwner, onboardingStatus } from "../../../../lib/onboarding/runtime";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const session = await onboardingOwner();
  if (isResponse(session)) return session;
  return Response.json(await onboardingStatus(session, new URL(request.url).searchParams.get("siteId") ?? undefined));
}
