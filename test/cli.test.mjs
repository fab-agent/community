import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import worker from "../server/src/index.js";
import { makeDb } from "./d1-shim.mjs";
import { loadOrCreateSigner, signEncKey } from "../src/sign.mjs";

const ADMIN = "root-admin-key";
const cliAsync = (dir, ...a) => new Promise((res, rej) => import("node:child_process").then(({ execFile }) =>
  execFile("node", ["src/cli.mjs", ...a], { env: { ...process.env, HERDR_PLUGIN_CONFIG_DIR: dir, HERDR_PLUGIN_STATE_DIR: dir + "/state" } }, (e, so, se) => e ? rej(new Error(se || e.message)) : res(so))));

test("agent CLI: encrypted DM round trip, verified, untrusted-labelled", async () => {
  const env = { DB: makeDb(), ADMIN_KEY: ADMIN, COMMUNITY_NAME: "t" };
  const srv = http.createServer(async (rq, rs) => {
    const chunks = []; for await (const c of rq) chunks.push(c);
    const r = await worker.fetch(new Request("http://x" + rq.url, { method: rq.method, headers: rq.headers, body: chunks.length ? Buffer.concat(chunks) : undefined }), env);
    rs.writeHead(r.status, { "content-type": "application/json" }); rs.end(await r.text());
  }).listen(0);
  await new Promise((r) => srv.on("listening", r));
  const url = `http://127.0.0.1:${srv.address().port}`;
  try {
    const mkMember = async (name) => {
      const m = await (await fetch(url + "/v1/admin/members", { method: "POST", headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" }, body: JSON.stringify({ name }) })).json();
      const dir = fs.mkdtempSync(os.tmpdir() + "/c"); const s = loadOrCreateSigner(dir);
      fs.writeFileSync(dir + "/config.json", JSON.stringify({ url, key: m.key, id: m.id, me: name }));
      const r = await fetch(url + "/v1/me/key", { method: "POST", headers: { authorization: `Bearer ${m.key}`, "content-type": "application/json" }, body: JSON.stringify({ pubkey: s.pubkey, enc_pubkey: s.encPub, enc_sig: signEncKey(s, m.id) }) });
      assert.equal(r.status, 200);
      return dir;
    };
    const ada = await mkMember("Ada"), bob = await mkMember("Bob");
    await cliAsync(ada, "send", "Bob", "hello bob ✓");
    const inbox = JSON.parse(await cliAsync(bob, "inbox"));
    assert.equal(inbox.messages.length, 1);
    assert.equal(inbox.messages[0].text, "hello bob ✓");
    assert.equal(inbox.messages[0].signature, "verified");
    assert.match(inbox.messages[0].trust, /untrusted/);
    assert.equal(inbox.messages[0].from, "Ada");
    await assert.rejects(cliAsync(ada, "send", "Nobody", "x"));
  } finally { srv.close(); }
});
