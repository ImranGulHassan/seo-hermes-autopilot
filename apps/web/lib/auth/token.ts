import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

const VERSION = "v1";

export function hashToken(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function signature(value: string, secret: string): string {
  return createHmac("sha256", secret).update(value, "utf8").digest("base64url");
}

export function createSessionToken(secret: string): { cookieValue: string; tokenHash: string; sessionId: string } {
  if (secret.length < 32) throw new Error("SESSION_SECRET must contain at least 32 characters.");
  const opaqueToken = randomBytes(32).toString("base64url");
  const payload = `${VERSION}.${opaqueToken}`;
  return { cookieValue: `${payload}.${signature(payload, secret)}`, tokenHash: hashToken(opaqueToken), sessionId: randomUUID() };
}

export function readSessionToken(cookieValue: string, secret: string): { tokenHash: string } | null {
  const [version, opaqueToken, receivedSignature, extra] = cookieValue.split(".");
  if (version !== VERSION || !opaqueToken || !receivedSignature || extra || secret.length < 32) return null;
  const expected = Buffer.from(signature(`${version}.${opaqueToken}`, secret));
  const received = Buffer.from(receivedSignature);
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) return null;
  return { tokenHash: hashToken(opaqueToken) };
}
