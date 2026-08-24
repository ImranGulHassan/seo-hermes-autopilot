import test from "node:test";
import assert from "node:assert/strict";
import { authorizeCron, withRetries } from "../lib/runtime-jobs.js";

test("cron authentication requires an exact bearer secret", () => {
  assert.equal(authorizeCron(new Request("https://example.test/api/cron/daily-scan"), "secret"), false);
  assert.equal(authorizeCron(new Request("https://example.test/api/cron/daily-scan", { headers: { authorization: "Bearer wrong" } }), "secret"), false);
  assert.equal(authorizeCron(new Request("https://example.test/api/cron/daily-scan", { headers: { authorization: "Bearer secret" } }), "secret"), true);
  assert.equal(authorizeCron(new Request("https://example.test/api/cron/daily-scan"), ""), false);
});

test("runtime jobs retry transient failures with a bounded attempt count", async () => {
  let attempts = 0;
  const result = await withRetries(async () => { if (++attempts < 3) throw new Error("transient"); return "ok"; });
  assert.equal(result, "ok");
  assert.equal(attempts, 3);
});
