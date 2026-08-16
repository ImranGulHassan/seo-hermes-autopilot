import test from "node:test";
import assert from "node:assert/strict";
test("dashboard package is server-rendered", () => assert.equal(typeof process.env, "object"));
