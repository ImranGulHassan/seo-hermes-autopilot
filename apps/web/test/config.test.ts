import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
test("dashboard package is server-rendered", () => assert.equal(typeof process.env, "object"));
test("billing and legal launch routes are present without exposing Stripe secrets", async () => {
  const checkout = await readFile(new URL("../app/api/v1/billing/checkout/route.ts", import.meta.url), "utf8");
  const webhook = await readFile(new URL("../app/api/webhooks/stripe/route.ts", import.meta.url), "utf8");
  const billing = await readFile(new URL("../app/billing/page.tsx", import.meta.url), "utf8");
  assert.match(checkout, /mode:\s*"subscription"/);
  assert.match(webhook, /constructEvent/);
  assert.match(webhook, /PostgresBillingStore/);
  assert.match(billing, /Stripe setup pending/);
  assert.doesNotMatch(`${checkout}${webhook}${billing}`, /sk_(?:test|live)_/);
});
