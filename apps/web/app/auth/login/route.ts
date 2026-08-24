import { NextResponse } from "next/server";
import { isSameOrigin, safeReturnPath } from "../../../lib/auth/request";
import { issueSession, redeemLoginToken } from "../../../lib/auth/session";

export async function POST(request: Request): Promise<Response> {
  if (!isSameOrigin(request)) return new NextResponse("Invalid request origin.", { status: 403 });
  const form = await request.formData();
  const rawToken = form.get("token");
  const returnTo = safeReturnPath(form.get("returnTo"));
  if (typeof rawToken !== "string") return NextResponse.redirect(new URL("/login?error=invalid", request.url), 303);
  const principal = await redeemLoginToken(rawToken);
  if (!principal) return NextResponse.redirect(new URL("/login?error=expired", request.url), 303);
  await issueSession(principal);
  return NextResponse.redirect(new URL(returnTo, request.url), 303);
}
