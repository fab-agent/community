import test from "node:test";
import assert from "node:assert/strict";
import worker from "../server/src/index.js";
import { makeDb } from "./d1-shim.mjs";

const ADMIN = "root-admin-key";
const mk = (extra = {}) => ({ DB: makeDb(), ADMIN_KEY: ADMIN, COMMUNITY_NAME: "t", ...extra });
const call = async (env, method, path, { key, body } = {}) => {
  const res = await worker.fetch(new Request("https://x.test" + path, {
    method,
    headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }), env);
  return { status: res.status, json: await res.json().catch(() => ({})) };
};
const addMember = async (env, name, role = "member") =>
  (await call(env, "POST", "/v1/admin/members", { key: ADMIN, body: { name, role } })).json;

test("community info is public and reports retention", async () => {
  const r = await call(mk({ MESSAGE_RETENTION_DAYS: "7" }), "GET", "/v1/community");
  assert.equal(r.status, 200);
  assert.equal(r.json.message_retention_days, 7);
});

test("member routes require a valid key", async () => {
  const env = mk();
  assert.equal((await call(env, "GET", "/v1/members")).status, 401);
  assert.equal((await call(env, "GET", "/v1/members", { key: "fck_nope" })).status, 401);
});

test("admin routes reject non-admins and wrong keys", async () => {
  const env = mk();
  const ada = await addMember(env, "Ada");
  assert.equal((await call(env, "GET", "/v1/admin/members", { key: "bad" })).status, 401);
  assert.equal((await call(env, "GET", "/v1/admin/members", { key: ada.key })).status, 401);
});

test("invite flow: single use, then rejected", async () => {
  const env = mk();
  const inv = await call(env, "POST", "/v1/admin/invites", { key: ADMIN, body: { name: "Bob", department: "Ops" } });
  assert.equal(inv.status, 201);
  const ok = await call(env, "POST", "/v1/join", { body: { code: inv.json.code } });
  assert.equal(ok.status, 201);
  assert.match(ok.json.key, /^fck_/);
  assert.equal((await call(env, "GET", "/v1/me", { key: ok.json.key })).json.name, "Bob");
  assert.equal((await call(env, "POST", "/v1/join", { body: { code: inv.json.code } })).status, 410);
});

test("expired invites cannot be redeemed", async () => {
  const env = mk();
  const inv = await call(env, "POST", "/v1/admin/invites", { key: ADMIN, body: { name: "Late" } });
  env.DB.raw.exec("UPDATE invites SET expires_at = 1");
  assert.equal((await call(env, "POST", "/v1/join", { body: { code: inv.json.code } })).status, 410);
});

test("invite creation is limited to one per minute per admin", async () => {
  const env = mk();
  assert.equal((await call(env, "POST", "/v1/admin/invites", { key: ADMIN, body: { name: "A" } })).status, 201);
  const second = await call(env, "POST", "/v1/admin/invites", { key: ADMIN, body: { name: "B" } });
  assert.equal(second.status, 429);
  assert.ok(second.json.retry_after > 0);
});

test("only the root key can invite admins", async () => {
  const env = mk();
  const ada = await addMember(env, "Ada", "admin");
  const r = await call(env, "POST", "/v1/admin/invites", { key: ada.key, body: { name: "Eve", role: "admin" } });
  assert.equal(r.status, 403);
  const ok = await call(env, "POST", "/v1/admin/invites", { key: ada.key, body: { name: "Eve" } });
  assert.equal(ok.status, 201);
});

test("messages are private to sender and recipient", async () => {
  const env = mk();
  const a = await addMember(env, "Ann"), b = await addMember(env, "Ben"), c = await addMember(env, "Cy");
  assert.equal((await call(env, "POST", "/v1/messages", { key: a.key, body: { to: "Ben", body: "hi" } })).status, 201);
  assert.equal((await call(env, "GET", "/v1/messages", { key: b.key })).json.length, 1);
  assert.equal((await call(env, "GET", "/v1/messages", { key: a.key })).json.length, 1);
  assert.equal((await call(env, "GET", "/v1/messages", { key: c.key })).json.length, 0);
});

test("control characters are stripped from names, titles and bodies", async () => {
  const env = mk();
  const a = await addMember(env, "Ann"), b = await addMember(env, "Ben");
  await call(env, "PATCH", "/v1/me", { key: a.key, body: { title: "x\u001b[2Jy", task: "line1\nline2" } });
  const me = (await call(env, "GET", "/v1/me", { key: a.key })).json;
  assert.equal(me.title, "x[2Jy");
  assert.equal(me.task, "line1 line2");
  await call(env, "POST", "/v1/messages", { key: a.key, body: { to: "Ben", body: "a\u001b]52;c;eA==\u0007b\nc" } });
  const m = (await call(env, "GET", "/v1/messages", { key: b.key })).json[0];
  assert.equal(m.body, "a]52;c;eA==b\nc"); // ESC and BEL gone, newline kept in bodies
});

test("rename: self, conflict, and admin editing others", async () => {
  const env = mk();
  const a = await addMember(env, "Ann"); await addMember(env, "Ben");
  assert.equal((await call(env, "PATCH", "/v1/me", { key: a.key, body: { name: "Ben" } })).status, 409);
  assert.equal((await call(env, "PATCH", "/v1/me", { key: a.key, body: { name: "Anna" } })).json.name, "Anna");
  const r = await call(env, "POST", "/v1/admin/members/Ben/profile", { key: ADMIN, body: { department: "QA" } });
  assert.equal(r.json.department, "QA");
});

test("revoked members lose access immediately and free their name", async () => {
  const env = mk();
  const a = await addMember(env, "Ann");
  await call(env, "POST", "/v1/admin/members/Ann/revoke", { key: ADMIN });
  assert.equal((await call(env, "GET", "/v1/me", { key: a.key })).status, 401);
  assert.equal((await addMember(env, "Ann")).name, "Ann");
});

test("retention hides and purges old messages", async () => {
  const env = mk({ MESSAGE_RETENTION_DAYS: "1" });
  const a = await addMember(env, "Ann"), b = await addMember(env, "Ben");
  await call(env, "POST", "/v1/messages", { key: a.key, body: { to: "Ben", body: "old" } });
  env.DB.raw.exec("UPDATE messages SET created_at = 1");
  await call(env, "POST", "/v1/messages", { key: a.key, body: { to: "Ben", body: "new" } });
  const seen = (await call(env, "GET", "/v1/messages", { key: b.key })).json;
  assert.deepEqual(seen.map((m) => m.body), ["new"]);
  const p = await call(env, "POST", "/v1/admin/purge", { key: ADMIN });
  assert.equal(p.json.deleted, 1);
});

// ---- signed messages & discussions ----
import fs from "node:fs";
import os from "node:os";
import { loadOrCreateSigner, signMessage, verifyMessage, dmTarget, topicTarget, verdict } from "../src/sign.mjs";
const signer = () => loadOrCreateSigner(fs.mkdtempSync(os.tmpdir() + "/sig"));

test("a member with a registered key must sign; forged, replayed and stale messages are rejected", async () => {
  const env = mk();
  const ada = await addMember(env, "Ada"), bob = await addMember(env, "Bob");
  const s = signer();
  assert.equal((await call(env, "POST", "/v1/me/key", { key: ada.key, body: { pubkey: s.pubkey } })).status, 200);
  assert.equal((await call(env, "POST", "/v1/me/key", { key: ada.key, body: { pubkey: s.pubkey } })).status, 409); // once only
  const unsigned = await call(env, "POST", "/v1/messages", { key: ada.key, body: { to: "Bob", body: "hi" } });
  assert.equal(unsigned.status, 400);
  const m = signMessage(s, ada.id, dmTarget(bob.id), "hello");
  assert.equal((await call(env, "POST", "/v1/messages", { key: ada.key, body: { to: "Bob", ...m } })).status, 201);
  assert.equal((await call(env, "POST", "/v1/messages", { key: ada.key, body: { to: "Bob", ...m } })).status, 409); // replay
  const tampered = signMessage(s, ada.id, dmTarget(bob.id), "pay me");
  assert.equal((await call(env, "POST", "/v1/messages", { key: ada.key, body: { to: "Bob", ...tampered, body: "pay him" } })).status, 400);
  const wrongTarget = signMessage(s, ada.id, dmTarget("someone-else"), "x"); // signature for another recipient
  assert.equal((await call(env, "POST", "/v1/messages", { key: ada.key, body: { to: "Bob", ...wrongTarget } })).status, 400);
  const stale = signMessage(s, ada.id, dmTarget(bob.id), "old");
  assert.equal((await call(env, "POST", "/v1/messages", { key: ada.key, body: { to: "Bob", ...stale, ts: Date.now() - 3_600_000 } })).status, 400);
  // the recipient gets something verifiable
  const got = (await call(env, "GET", "/v1/messages", { key: bob.key })).json;
  assert.equal(got.length, 1);
  assert.equal(verifyMessage(s.pubkey, { ...got[0], target: dmTarget(bob.id) }), true);
  assert.equal(verifyMessage(s.pubkey, { ...got[0], body: "other", target: dmTarget(bob.id) }), false);
});

test("members without a key can still message (legacy); admin can reset a lost key", async () => {
  const env = mk();
  const ada = await addMember(env, "Ada"); await addMember(env, "Bob");
  assert.equal((await call(env, "POST", "/v1/messages", { key: ada.key, body: { to: "Bob", body: "plain" } })).status, 201);
  const s = signer();
  await call(env, "POST", "/v1/me/key", { key: ada.key, body: { pubkey: s.pubkey } });
  assert.equal((await call(env, "POST", "/v1/admin/members/Ada/reset-key", { key: ADMIN })).json.updated, 1);
  assert.equal((await call(env, "POST", "/v1/me/key", { key: ada.key, body: { pubkey: signer().pubkey } })).status, 200);
});

test("client verdicts: ok, unsigned, changed key, bad signature", () => {
  const s = signer(), other = signer(), pins = {};
  const member = { id: "A", pubkey: s.pubkey };
  const m = { from_id: "A", ...signMessage(s, "A", dmTarget("B"), "hi") };
  assert.equal(verdict(pins, member, m, dmTarget("B")), "ok");
  assert.equal(verdict(pins, member, { ...m, body: "evil" }, dmTarget("B")), "bad");
  assert.equal(verdict(pins, member, { ...m, sig: null }, dmTarget("B")), "unsigned");
  assert.equal(verdict(pins, { id: "A", pubkey: other.pubkey }, m, dmTarget("B")), "changed");
  assert.equal(verdict({}, { id: "Z" }, { from_id: "Z", sig: null }, dmTarget("B")), "unsigned");
});

test("discussions: anyone opens a topic, posts, admin archives; rate limit; DMs stay separate", async () => {
  const env = mk();
  const ada = await addMember(env, "Ada"), bob = await addMember(env, "Bob");
  const t = await call(env, "POST", "/v1/topics", { key: ada.key, body: { title: "Release plan\u001b[2J" } });
  assert.equal(t.status, 201);
  assert.equal((await call(env, "POST", "/v1/topics", { key: ada.key, body: { title: "again" } })).status, 429);
  const id = t.json.id;
  assert.equal((await call(env, "POST", `/v1/topics/${id}/messages`, { key: bob.key, body: { body: "agree" } })).status, 201);
  const msgs = (await call(env, "GET", `/v1/topics/${id}/messages`, { key: ada.key })).json;
  assert.equal(msgs.length, 1); assert.equal(msgs[0].from_name, "Bob");
  const list = (await call(env, "GET", "/v1/topics", { key: ada.key })).json;
  assert.equal(list[0].title, "Release plan[2J"); assert.equal(list[0].messages, 1);
  // topic posts never show up as direct messages
  assert.equal((await call(env, "GET", "/v1/messages", { key: ada.key })).json.length, 0);
  // signed topic message is bound to its topic
  const s = signer(); await call(env, "POST", "/v1/me/key", { key: bob.key, body: { pubkey: s.pubkey } });
  const m = signMessage(s, bob.id, topicTarget(id), "signed");
  assert.equal((await call(env, "POST", `/v1/topics/${id}/messages`, { key: bob.key, body: m })).status, 201);
  const wrong = signMessage(s, bob.id, topicTarget(id + 1), "cross-post");
  assert.equal((await call(env, "POST", `/v1/topics/${id}/messages`, { key: bob.key, body: wrong })).status, 400);
  // archive: members cannot, admin can; archived topics reject posts
  assert.equal((await call(env, "POST", `/v1/admin/topics/${id}/archive`, { key: bob.key })).status, 401);
  assert.equal((await call(env, "POST", `/v1/admin/topics/${id}/archive`, { key: ADMIN })).status, 200);
  assert.equal((await call(env, "POST", `/v1/topics/${id}/messages`, { key: ada.key, body: { body: "late" } })).status, 409);
});
