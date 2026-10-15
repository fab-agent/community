import test from "node:test";
import assert from "node:assert/strict";
import worker, { INSTALLER_REF } from "../server/src/index.js";
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
  assert.equal((await call(env, "POST", "/v1/me/key", { key: ada.key, body: { pubkey: s.pubkey } })).status, 200); // same key: idempotent
  assert.equal((await call(env, "POST", "/v1/me/key", { key: ada.key, body: { pubkey: signer().pubkey } })).status, 409); // different key: needs admin reset
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

// ---- encryption keys & private topics ----
import { signEncKey, signBytes } from "../src/sign.mjs";
import { sealDM, openDM, newTopicKey, wrapKey, sealTopicText, openTopicText, bundleCanonical } from "../src/e2ee.mjs";
const enroll = async (env, name) => {
  const m = await addMember(env, name), d = signer();
  const r = await call(env, "POST", "/v1/me/key", { key: m.key, body: { pubkey: d.pubkey, enc_pubkey: d.encPub, enc_sig: signEncKey(d, m.id) } });
  assert.equal(r.status, 200);
  return { ...m, d };
};

test("encryption key must be vouched for by the signing key; admin reset clears it", async () => {
  const env = mk();
  const ada = await addMember(env, "Ada"), d = signer(), other = signer();
  const bad = await call(env, "POST", "/v1/me/key", { key: ada.key, body: { pubkey: d.pubkey, enc_pubkey: other.encPub, enc_sig: signEncKey(d, ada.id) } });
  assert.equal(bad.status, 400); // server (or anyone) cannot register a key the device did not sign
  await call(env, "POST", "/v1/me/key", { key: ada.key, body: { pubkey: d.pubkey, enc_pubkey: d.encPub, enc_sig: signEncKey(d, ada.id) } });
  const list = (await call(env, "GET", "/v1/members", { key: ada.key })).json;
  assert.equal(list[0].enc_pubkey, d.encPub);
  await call(env, "POST", "/v1/admin/members/Ada/reset-key", { key: ADMIN });
  assert.equal((await call(env, "GET", "/v1/members", { key: ada.key })).json[0].enc_pubkey, null);
});

test("encrypted direct message round trip through the server (server sees no plaintext)", async () => {
  const env = mk();
  const a = await enroll(env, "Ada"), b = await enroll(env, "Bob");
  const envp = sealDM("the launch code", a.id, `dm:${b.id}`, [{ id: a.id, encPub: a.d.encPub }, { id: b.id, encPub: b.d.encPub }]);
  const m = signMessage(a.d, a.id, dmTarget(b.id), envp);
  assert.equal((await call(env, "POST", "/v1/messages", { key: a.key, body: { to: b.id, ...m } })).status, 201);
  const row = (await call(env, "GET", "/v1/messages", { key: b.key })).json[0];
  assert.ok(!row.body.includes("launch"));
  assert.equal(openDM(row.body, b.id, b.d.encPriv, a.id, dmTarget(b.id)), "the launch code");
  assert.equal(verifyMessage(a.d.pubkey, { ...row, target: dmTarget(b.id) }), true);
});

test("private topic: members only, key bundle signed, plaintext rejected, outsiders see nothing", async () => {
  const env = mk();
  const a = await enroll(env, "Ada"), b = await enroll(env, "Bob"), c = await enroll(env, "Cem");
  const tk = newTopicKey(), titleEnv = sealTopicText(tk, "Budget", "title");
  const wraps = { [a.id]: JSON.stringify(wrapKey(a.d.encPub, tk, a.id)), [b.id]: JSON.stringify(wrapKey(b.d.encPub, tk, b.id)) };
  const make = (extra = {}) => ({ private: true, title: titleEnv, wraps, bundle_sig: signBytes(a.d, bundleCanonical(a.id, titleEnv, wraps)), ...extra });
  assert.equal((await call(env, "POST", "/v1/topics", { key: a.key, body: make({ bundle_sig: signBytes(b.d, "x") }) })).status, 400); // forged bundle
  assert.equal((await call(env, "POST", "/v1/topics", { key: a.key, body: make({ title: "Budget" }) })).status, 400);               // plaintext title
  const made = await call(env, "POST", "/v1/topics", { key: a.key, body: make() });
  assert.equal(made.status, 201);
  const id = made.json.id;
  // listing: members get their wrap, outsiders get nothing
  const mine = (await call(env, "GET", "/v1/topics", { key: b.key })).json;
  assert.equal(mine.length, 1); assert.equal(mine[0].private, true); assert.ok(mine[0].my_wrap); assert.equal(mine[0].members.length, 2);
  assert.equal((await call(env, "GET", "/v1/topics", { key: c.key })).json.length, 0);
  assert.equal((await call(env, "GET", `/v1/topics/${id}/messages`, { key: c.key })).status, 404);
  assert.equal((await call(env, "POST", `/v1/topics/${id}/messages`, { key: c.key, body: { body: "e2ee1t:xx" } })).status, 404);
  // only ciphertext is accepted
  assert.equal((await call(env, "POST", `/v1/topics/${id}/messages`, { key: b.key, body: signMessage(b.d, b.id, topicTarget(id), "plain") })).status, 400);
  const enc = sealTopicText(tk, "agreed", `topic:${id}\n${b.id}`);
  assert.equal((await call(env, "POST", `/v1/topics/${id}/messages`, { key: b.key, body: signMessage(b.d, b.id, topicTarget(id), enc) })).status, 201);
  const got = (await call(env, "GET", `/v1/topics/${id}/messages`, { key: a.key })).json;
  assert.equal(openTopicText(tk, got[0].body, `topic:${id}\n${b.id}`), "agreed");
  // creator archives; removed members lose all access
  assert.equal((await call(env, "POST", `/v1/topics/${id}/archive`, { key: b.key })).status, 403);
  assert.equal((await call(env, "POST", `/v1/topics/${id}/archive`, { key: a.key })).status, 200);
  await call(env, "POST", "/v1/admin/members/Bob/revoke", { key: ADMIN });
  assert.equal((await call(env, "GET", `/v1/topics/${id}/messages`, { key: b.key })).status, 401);
});

// ---- Server Agents -------------------------------------------------------------
const agentInvite = async (env, name, policy, by = ADMIN) => {
  const inv = await call(env, "POST", "/v1/admin/invites", { key: by, body: { name, kind: "server_agent", role: "admin", policy } });
  assert.equal(inv.status, 201);
  assert.equal(inv.json.role, "member"); // an agent can never be invited as admin
  const s = signer();
  const j = await call(env, "POST", "/v1/join", { body: { code: inv.json.code, pubkey: s.pubkey } });
  assert.equal(j.status, 201);
  return { ...j.json, s };
};

test("server agent: kind and default policy; DMs only to admins; no topics; must have a signing key", async () => {
  const env = mk();
  const boss = await addMember(env, "Boss", "admin"), ada = await addMember(env, "Ada");
  const ag = await agentInvite(env, "Srv1");
  assert.equal(ag.kind, "server_agent");
  assert.equal((await call(env, "GET", "/v1/me", { key: ag.key })).json.kind, "server_agent");
  const toBoss = signMessage(ag.s, ag.id, dmTarget(boss.id), "deploy done");
  assert.equal((await call(env, "POST", "/v1/messages", { key: ag.key, body: { to: "Boss", ...toBoss } })).status, 201);
  const toAda = signMessage(ag.s, ag.id, dmTarget(ada.id), "hi");
  assert.equal((await call(env, "POST", "/v1/messages", { key: ag.key, body: { to: "Ada", ...toAda } })).status, 403);
  assert.equal((await call(env, "POST", "/v1/topics", { key: ag.key, body: { title: "x" } })).status, 403);
  // an agent that never registered a key cannot send at all
  env.DB.raw.exec("UPDATE invites SET created_at = 1"); // lift the invite rate limit
  const inv2 = await call(env, "POST", "/v1/admin/invites", { key: ADMIN, body: { name: "Srv2", kind: "server_agent" } });
  const j2 = await call(env, "POST", "/v1/join", { body: { code: inv2.json.code } });
  assert.equal((await call(env, "POST", "/v1/messages", { key: j2.json.key, body: { to: "Boss", body: "unsigned" } })).status, 403);
});

test("server agent: allowlist, rate limit and size are enforced by the server", async () => {
  const env = mk();
  const ada = await addMember(env, "Ada"), bob = await addMember(env, "Bob");
  const ag = await agentInvite(env, "Srv1", { recipients: ["ada"], rate: { max: 2, window_s: 600 }, max_body: 20 });
  const send = (to, id, text) => call(env, "POST", "/v1/messages", { key: ag.key, body: { to, ...signMessage(ag.s, ag.id, dmTarget(id), text) } });
  assert.equal((await send("Ada", ada.id, "one")).status, 201);
  assert.equal((await send("Bob", bob.id, "nope")).status, 403); // not on the allowlist
  assert.equal((await send("Ada", ada.id, "two")).status, 201);
  const limited = await send("Ada", ada.id, "three");
  assert.equal(limited.status, 429);
  assert.ok(limited.json.retry_after >= 1);
  env.DB.raw.exec("UPDATE messages SET created_at = 1"); // window passes
  assert.equal((await send("Ada", ada.id, "x".repeat(21))).status, 413);
  assert.equal((await send("Ada", ada.id, "ok again")).status, 201);
});

test("server agent: policy is admin-editable; humans are unaffected", async () => {
  const env = mk();
  const ada = await addMember(env, "Ada"), bob = await addMember(env, "Bob");
  const ag = await agentInvite(env, "Srv1");
  assert.equal((await call(env, "POST", "/v1/admin/members/Ada/policy", { key: ADMIN, body: { recipients: ["bob"] } })).status, 404); // humans have no policy
  const set = await call(env, "POST", "/v1/admin/members/Srv1/policy", { key: ADMIN, body: { recipients: ["Bob"], rate: { max: 5, window_s: 60 } } });
  assert.equal(set.status, 200);
  assert.deepEqual(set.json.policy.recipients, ["bob"]);
  const m = signMessage(ag.s, ag.id, dmTarget(bob.id), "hello");
  assert.equal((await call(env, "POST", "/v1/messages", { key: ag.key, body: { to: "Bob", ...m } })).status, 201);
  for (let i = 0; i < 30; i++) // humans have no agent rate limit
    assert.equal((await call(env, "POST", "/v1/messages", { key: ada.key, body: { to: "Bob", body: "m" + i } })).status, 201);
});

test("server agent: private topics and public topic posts follow policy", async () => {
  const env = mk();
  const ada = await addMember(env, "Ada");
  const ag = await agentInvite(env, "Srv1");
  const t = await call(env, "POST", "/v1/topics", { key: ada.key, body: { title: "Ops" } });
  const post = (text) => call(env, "POST", `/v1/topics/${t.json.id}/messages`, { key: ag.key, body: signMessage(ag.s, ag.id, topicTarget(t.json.id), text) });
  assert.equal((await post("status ok")).status, 201);
  await call(env, "POST", "/v1/admin/members/Srv1/policy", { key: ADMIN, body: { topics: "none" } });
  assert.equal((await post("again")).status, 403);
});

test("signed via/at labels: stored, returned, bound to the signature", async () => {
  const env = mk();
  const boss = await addMember(env, "Boss", "admin");
  const ag = await agentInvite(env, "Srv1");
  const m = signMessage(ag.s, ag.id, dmTarget(boss.id), "build green", { via: "deploy-bot", at: "vps-1" });
  assert.equal(m.via, "deploy-bot");
  assert.equal((await call(env, "POST", "/v1/messages", { key: ag.key, body: { to: "Boss", ...m } })).status, 201);
  const got = (await call(env, "GET", "/v1/messages", { key: boss.key })).json[0];
  assert.equal(got.via, "deploy-bot");
  assert.equal(got.at, "vps-1");
  assert.equal(verifyMessage(ag.s.pubkey, { ...got, target: dmTarget(boss.id) }), true);
  assert.equal(verifyMessage(ag.s.pubkey, { ...got, via: "someone-else", target: dmTarget(boss.id) }), false); // label is signed
  // an attacker or buggy client cannot swap the label after signing
  const m2 = signMessage(ag.s, ag.id, dmTarget(boss.id), "x", { via: "a" });
  assert.equal((await call(env, "POST", "/v1/messages", { key: ag.key, body: { to: "Boss", ...m2, via: "b" } })).status, 400);
  // messages without labels still use the original v1 format
  const plain = signMessage(ag.s, ag.id, dmTarget(boss.id), "plain");
  assert.equal(plain.via, undefined);
  assert.equal((await call(env, "POST", "/v1/messages", { key: ag.key, body: { to: "Boss", ...plain } })).status, 201);
});

test("server agents: no presence, no last_seen writes; the inviting admin is the owner", async () => {
  const env = mk();
  const boss = await addMember(env, "Boss", "admin"), ada = await addMember(env, "Ada");
  const inv = await call(env, "POST", "/v1/admin/invites", { key: boss.key, body: { name: "Srv1", kind: "server_agent" } });
  assert.equal(inv.status, 201);
  const s = signer();
  const j = await call(env, "POST", "/v1/join", { body: { code: inv.json.code, pubkey: s.pubkey } });
  await call(env, "GET", "/v1/members", { key: j.json.key }); // an authenticated request
  const list = (await call(env, "GET", "/v1/members", { key: ada.key })).json;
  const srv = list.find((m) => m.name === "Srv1");
  assert.equal(srv.kind, "server_agent");
  assert.equal(srv.owner, "Boss");
  assert.equal(srv.online, null);
  assert.equal(srv.last_seen, 0);
  assert.equal(list.find((m) => m.name === "Ada").owner, null);
  assert.equal(env.DB.raw.prepare("SELECT last_seen FROM members WHERE name='Srv1'").get().last_seen, 0); // no D1 write
  // humans keep presence
  assert.equal(typeof list.find((m) => m.name === "Ada").online, "boolean");
  // a root-invited server has no owner until an admin assigns one
  env.DB.raw.exec("UPDATE invites SET created_at = 1");
  const inv2 = await call(env, "POST", "/v1/admin/invites", { key: ADMIN, body: { name: "Srv2", kind: "server_agent" } });
  await call(env, "POST", "/v1/join", { body: { code: inv2.json.code } });
  assert.equal((await call(env, "GET", "/v1/members", { key: ada.key })).json.find((m) => m.name === "Srv2").owner, null);
  assert.equal((await call(env, "POST", "/v1/admin/members/Srv2/owner", { key: ADMIN, body: { owner: "Boss" } })).json.owner, "Boss");
  assert.equal((await call(env, "POST", "/v1/admin/members/Ada/owner", { key: ADMIN, body: { owner: "Boss" } })).status, 404); // humans have no owner
  assert.equal((await call(env, "GET", "/v1/members", { key: ada.key })).json.find((m) => m.name === "Srv2").owner, "Boss");
});

test("short install URL: serves a script for a well-formed code, needs no auth, does not touch the invite", async () => {
  const env = mk();
  const inv = await call(env, "POST", "/v1/admin/invites", { key: ADMIN, body: { name: "Srv1", kind: "server_agent" } });
  const get = (p) => worker.fetch(new Request("https://community.example" + p), env);
  const r = await get(`/install/${inv.json.code}`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /shellscript/);
  const body = await r.text();
  assert.ok(body.includes(`raw.githubusercontent.com/fab-agent/community/${INSTALLER_REF}/scripts/install.sh | sh -s -- 'https://community.example' '${inv.json.code}'`));
  assert.ok(!body.includes("--hardened"));
  const hard = await (await get(`/install/${inv.json.code}?hardened=1&label=build-box`)).text();
  assert.ok(hard.includes(`'build-box' --hardened`));
  // labels that are not plain are dropped, never put into the shell line
  const evil = await (await get(`/install/${inv.json.code}?label=${encodeURIComponent("x'; rm -rf /; '")}`)).text();
  assert.ok(!evil.includes("rm -rf"));
  // malformed codes are not served
  for (const bad of ["/install/not-a-code", `/install/${inv.json.code};id`]) {
    const x = await get(bad);
    assert.notEqual(x.status, 200); // falls through to member auth, never a script
    assert.ok(!(await x.text()).includes("#!/bin/sh"));
  }
  // the invite is still usable afterwards
  assert.equal((await call(env, "POST", "/v1/join", { body: { code: inv.json.code } })).status, 201);
});
