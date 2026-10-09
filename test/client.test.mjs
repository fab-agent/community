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

import fs from "node:fs";
import os from "node:os";
import { loadOrCreateSigner, signEncKey, verifyEncKey, signBytes, verifyBytes } from "../src/sign.mjs";
import { sealDM, openDM, newTopicKey, wrapKey, unwrapKey, sealTopicText, openTopicText, bundleCanonical } from "../src/e2ee.mjs";
const dev = () => loadOrCreateSigner(fs.mkdtempSync(os.tmpdir() + "/e"));

test("encryption key is vouched for by the signing key", () => {
  const a = dev(), b = dev();
  const sig = signEncKey(a, "A");
  assert.equal(verifyEncKey(a.pubkey, "A", a.encPub, sig), true);
  assert.equal(verifyEncKey(a.pubkey, "A", b.encPub, sig), false); // server swapped the key
  assert.equal(verifyEncKey(b.pubkey, "A", a.encPub, sig), false);
});

test("DM: recipient and sender can read, a third device and tampering cannot", () => {
  const a = dev(), b = dev(), c = dev();
  const env = sealDM("secret ✓ merhaba", "A", "dm:B", [{ id: "A", encPub: a.encPub }, { id: "B", encPub: b.encPub }]);
  assert.ok(!env.includes("secret"));
  assert.equal(openDM(env, "B", b.encPriv, "A", "dm:B"), "secret ✓ merhaba");
  assert.equal(openDM(env, "A", a.encPriv, "A", "dm:B"), "secret ✓ merhaba");
  assert.equal(openDM(env, "B", c.encPriv, "A", "dm:B"), null);          // wrong device
  assert.equal(openDM(env, "B", b.encPriv, "A", "dm:Z"), null);          // moved to another conversation
  assert.equal(openDM(env, "B", b.encPriv, "X", "dm:B"), null);          // claimed sender differs
  assert.equal(openDM(env.slice(0, -4) + "AAAA", "B", b.encPriv, "A", "dm:B"), null);
});

test("private topic: members unwrap the topic key; outsiders and a swapped key fail; bundle signature binds wraps", () => {
  const a = dev(), b = dev(), x = dev();
  const tk = newTopicKey();
  const wa = JSON.stringify(wrapKey(a.encPub, tk, "A")), wb = JSON.stringify(wrapKey(b.encPub, tk, "B"));
  assert.deepEqual(unwrapKey(b.encPriv, JSON.parse(wb), "B"), tk);
  assert.throws(() => unwrapKey(x.encPriv, JSON.parse(wb), "B"));
  const m = sealTopicText(tk, "plan", "topic:1\nA");
  assert.equal(openTopicText(tk, m, "topic:1\nA"), "plan");
  assert.equal(openTopicText(newTopicKey(), m, "topic:1\nA"), null);
  const canon = bundleCanonical("A", "title-env", { A: wa, B: wb });
  const sig = signBytes(a, canon);
  assert.equal(verifyBytes(a.pubkey, canon, sig), true);
  assert.equal(verifyBytes(a.pubkey, bundleCanonical("A", "title-env", { A: wa, B: JSON.stringify(wrapKey(b.encPub, newTopicKey(), "B")) }), sig), false);
});
