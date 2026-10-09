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

import { newer, checkUpdate } from "../src/update.mjs";
test("version compare", () => {
  assert.equal(newer("v0.3.0", "0.2.0"), true);
  assert.equal(newer("0.2.0", "0.2.0"), false);
  assert.equal(newer("0.2.1", "0.10.0"), false);
  assert.equal(newer("1.0.0", "0.9.9"), true);
});
test("update check caches for 6 hours and never throws", async () => {
  let cache = null, calls = 0;
  const store = { read: () => cache, write: (o) => { cache = o; } };
  const f = async () => { calls++; return { ok: true, json: async () => ({ tag_name: "v0.3.0" }) }; };
  assert.equal(await checkUpdate("0.2.0", store, f, 1000), "0.3.0");
  assert.equal(await checkUpdate("0.2.0", store, f, 2000), "0.3.0");
  assert.equal(calls, 1);
  assert.equal(await checkUpdate("0.3.0", store, f, 3000), null);
  const bad = { read: () => null, write() {} };
  assert.equal(await checkUpdate("0.2.0", bad, async () => { throw new Error("offline"); }), null);
});
