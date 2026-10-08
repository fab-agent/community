import test from "node:test";
import assert from "node:assert/strict";
import { clean, oneLine } from "../src/lib.mjs";

test("clean removes escape sequences but keeps newlines and tabs", () => {
  assert.equal(clean("a\u001b[2Jb\u0007c\nd\te"), "a[2Jbc\nd\te");
  assert.equal(clean("x‮y"), "xy"); // bidi override
});

test("oneLine never lets text press Enter or inject escapes", () => {
  const out = oneLine("echo hi\nrm -rf ~\r\n\u001b[31m");
  assert.ok(!/[\x00-\x1f\x7f]/.test(out));
  assert.equal(out.startsWith("echo hi"), true);
});

test("clean tolerates null and numbers", () => {
  assert.equal(clean(null), "");
  assert.equal(clean(5), "5");
});
