import test from "node:test";
import assert from "node:assert/strict";
import { decryptCredential, encryptCredential } from "../lib/onboarding/credentials.js";

test("connector credentials are authenticated, encrypted envelopes", () => {
  process.env.SESSION_SECRET = "test-session-secret-that-is-longer-than-thirty-two-characters";
  const envelope = encryptCredential("refresh-secret");
  assert.ok(!envelope.includes("refresh-secret"));
  assert.equal(decryptCredential(envelope), "refresh-secret");
  assert.throws(() => decryptCredential(`${envelope.slice(0, -1)}x`), /could not be decrypted/);
});
