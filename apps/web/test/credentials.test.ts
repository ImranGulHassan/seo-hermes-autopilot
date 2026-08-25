import test from "node:test";
import assert from "node:assert/strict";
import { decryptCredential, encryptCredential } from "../lib/onboarding/credentials.js";

test("connector credentials are authenticated, encrypted envelopes", () => {
  process.env.SESSION_SECRET = "test-session-secret-that-is-longer-than-thirty-two-characters";
  const envelope = encryptCredential("refresh-secret");
  assert.ok(!envelope.includes("refresh-secret"));
  assert.equal(decryptCredential(envelope), "refresh-secret");
  const [version, iv, tag, ciphertext] = envelope.split(".");
  const tampered = `${version}.${iv}.${tag}.${ciphertext?.startsWith("A") ? "B" : "A"}${ciphertext?.slice(1)}`;
  assert.throws(() => decryptCredential(tampered), /could not be decrypted/);
});
