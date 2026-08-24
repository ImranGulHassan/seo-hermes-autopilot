import { NextResponse } from "next/server";
import { isSameOrigin } from "../../../lib/auth/request";
import { revokeCurrentSession } from "../../../lib/auth/session";

export async function POST(request: Request): Promise<Response> {
  if (!isSameOrigin(request)) return new NextResponse("Invalid request origin.", { status: 403 });
  await revokeCurrentSession();
  return NextResponse.redirect(new URL("/login", request.url), 303);
}
