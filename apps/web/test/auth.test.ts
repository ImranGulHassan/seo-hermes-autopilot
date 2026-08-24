import test from "node:test";
import assert from "node:assert/strict";
import { createSessionToken, hashToken, readSessionToken } from "../lib/auth/token";
import { isSameOrigin, safeReturnPath } from "../lib/auth/request";
import { hasMinimumRole } from "../lib/auth/session";

const secret = "a-test-secret-with-at-least-thirty-two-characters";

test("session cookies are signed and expose no database token hash", () => {
  const issued = createSessionToken(secret);
  assert.match(issued.cookieValue, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.notEqual(issued.cookieValue, issued.tokenHash);
  assert.deepEqual(readSessionToken(issued.cookieValue, secret), { tokenHash: issued.tokenHash });
});

test("modified and wrongly signed session cookies are rejected", () => {
  const issued = createSessionToken(secret);
  assert.equal(readSessionToken(`${issued.cookieValue}x`, secret), null);
  assert.equal(readSessionToken(issued.cookieValue, `${secret}-different`), null);
  assert.equal(readSessionToken("v1.incomplete", secret), null);
});

test("token hashes are stable without preserving the secret", () => {
  assert.equal(hashToken("example"), hashToken("example"));
  assert.notEqual(hashToken("example"), hashToken("different"));
});

test("return paths cannot escape the application", () => {
  assert.equal(safeReturnPath("/sites/site_1"), "/sites/site_1");
  assert.equal(safeReturnPath("//attacker.example"), "/");
  assert.equal(safeReturnPath("https://attacker.example"), "/");
});

test("state-changing requests require a matching origin", () => {
  assert.equal(isSameOrigin(new Request("https://app.example/auth/logout", { headers: { origin: "https://app.example", host: "app.example" } })), true);
  assert.equal(isSameOrigin(new Request("https://app.example/auth/logout", { headers: { origin: "https://attacker.example", host: "app.example" } })), false);
  assert.equal(isSameOrigin(new Request("https://app.example/auth/logout", { headers: { host: "app.example" } })), false);
});

test("organization roles cannot exceed their approval authority", () => {
  assert.equal(hasMinimumRole("owner", "approver"), true);
  assert.equal(hasMinimumRole("approver", "approver"), true);
  assert.equal(hasMinimumRole("viewer", "approver"), false);
  assert.equal(hasMinimumRole("approver", "owner"), false);
});
