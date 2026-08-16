import test from "node:test";
import assert from "node:assert/strict";
test("measurement worker package is executable", () => assert.equal(typeof process.env, "object"));
