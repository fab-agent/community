import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import { spawn, execFile } from "node:child_process";
import worker from "../server/src/index.js";
import { makeDb } from "./d1-shim.mjs";
import { loadOrCreateSigner, signEncKey } from "../src/sign.mjs";

const ADMIN = "root-admin-key";
const ask = (sock, req) => new Promise((res, rej) => {
  const c = net.connect(sock, () => c.write(JSON.stringify(req) + "\n"));
  let b = ""; c.on("data", (d) => (b += d)); c.on("end", () => res(JSON.parse(b))); c.on("error", rej);
});
const cli = (dir, ...a) => new Promise((res, rej) => execFile("node", ["src/cli.mjs", ...a], { env: { PATH: process.env.PATH, HOME: dir, COMMUNITY_CONFIG_DIR: dir } }, (e, so, se) => e ? rej(new Error(se)) : res(so)));

test("broker: policy, redaction, machine label, caller label cannot be overridden by text", async () => {
  const env = { DB: makeDb(), ADMIN_KEY: ADMIN, COMMUNITY_NAME: "t" };
  const srv = http.createServer(async (rq, rs) => {
    const chunks = []; for await (const c of rq) chunks.push(c);
    const r = await worker.fetch(new Request("http://x" + rq.url, { method: rq.method, headers: rq.headers, body: chunks.length ? Buffer.concat(chunks) : undefined }), env);
    rs.writeHead(r.status, { "content-type": "application/json" }); rs.end(await r.text());
  }).listen(0);
  await new Promise((r) => srv.on("listening", r));
  const url = `http://127.0.0.1:${srv.address().port}`;
  const post = (p, key, body) => fetch(url + p, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  let broker;
  try {
    const boss = await (await post("/v1/admin/members", ADMIN, { name: "Boss", role: "admin" })).json();
    const bdir = fs.mkdtempSync(os.tmpdir() + "/boss"); const bs = loadOrCreateSigner(bdir);
    fs.writeFileSync(bdir + "/config.json", JSON.stringify({ url, key: boss.key, id: boss.id, me: "Boss" }));
    await post("/v1/me/key", boss.key, { pubkey: bs.pubkey, enc_pubkey: bs.encPub, enc_sig: signEncKey(bs, boss.id) });
    // admin policy allows Boss only; the broker additionally pins Boss
    const inv = await (await post("/v1/admin/invites", ADMIN, { name: "Srv1", kind: "server_agent" })).json();
    const adir = fs.mkdtempSync(os.tmpdir() + "/agent");
    await cli(adir, "join", url, inv.code);
    fs.writeFileSync(adir + "/broker.json", JSON.stringify({ at: "vps-1", recipients: ["Boss"], rate: { max: 3, window_s: 600 }, max_body: 200 }));
    const sock = fs.mkdtempSync(os.tmpdir() + "/sock") + "/b.sock";
    broker = spawn("node", ["src/broker.mjs", "--config-dir", adir, "--socket", sock], { env: { PATH: process.env.PATH, HOME: adir }, stdio: "ignore" });
    for (let i = 0; i < 50 && !fs.existsSync(sock); i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(fs.statSync(sock).mode & 0o777, 0o660);

    const r1 = await ask(sock, { cmd: "send", to: "Boss", text: "deploy done --via evil --at elsewhere", via: "deploy-bot" });
    assert.equal(r1.ok, true, JSON.stringify(r1));
    const r2 = await ask(sock, { cmd: "send", to: "Boss", text: "key is sk-abcdefghijklmnopqrstuvwxyz123456", via: "ci" });
    assert.equal(r2.ok, true);
    assert.equal(r2.redacted, 1);
    const inbox = JSON.parse(await cli(bdir, "inbox")).messages;
    assert.equal(inbox.length, 2);
    assert.equal(inbox[0].via, "deploy-bot"); // not "evil"
    assert.equal(inbox[0].location, "vps-1"); // not "elsewhere"
    assert.equal(inbox[0].text, "deploy done --via evil --at elsewhere"); // text kept verbatim
    assert.equal(inbox[0].signature, "verified");
    assert.ok(!inbox[1].text.includes("sk-abcdefgh"));

    assert.match((await ask(sock, { cmd: "send", to: "Ada", text: "x" })).error, /not allowed/);
    assert.match((await ask(sock, { cmd: "exec", text: "rm -rf /" })).error, /unknown command/);
    assert.match((await ask(sock, { cmd: "send", to: "Boss", text: "y".repeat(201) })).error, /too large/);
    assert.equal((await ask(sock, { cmd: "send", to: "Boss", text: "third", via: "a" })).ok, true);
    const limited = await ask(sock, { cmd: "send", to: "Boss", text: "fourth", via: "a" });
    assert.equal(limited.ok, false);
    assert.match(limited.error, /rate limit/);
    assert.ok((await ask(sock, { cmd: "who" })).result.some((m) => m.name === "Boss"));
  } finally { broker?.kill(); srv.close(); }
});
