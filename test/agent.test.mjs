import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import { spawn, execFile } from "node:child_process";
import worker from "../server/src/index.js";
import { makeDb } from "./d1-shim.mjs";
import { loadOrCreateSigner, signEncKey } from "../src/sign.mjs";

const ADMIN = "root-admin-key";
const sh = (file, args, env) => new Promise((res, rej) => execFile(file, args, { env: { PATH: process.env.PATH, ...env } }, (e, so, se) => e ? rej(new Error(`${file} ${args.slice(0, 3).join(" ")}: ${se || e.message}`)) : res(so)));
const boot = async () => {
  const env = { DB: makeDb(), ADMIN_KEY: ADMIN, COMMUNITY_NAME: "t" };
  const srv = http.createServer(async (rq, rs) => {
    const chunks = []; for await (const c of rq) chunks.push(c);
    const r = await worker.fetch(new Request("http://x" + rq.url, { method: rq.method, headers: rq.headers, body: chunks.length ? Buffer.concat(chunks) : undefined }), env);
    rs.writeHead(r.status, { "content-type": "application/json" }); rs.end(await r.text());
  }).listen(0);
  await new Promise((r) => srv.on("listening", r));
  const url = `http://127.0.0.1:${srv.address().port}`;
  const post = (p, key, body) => fetch(url + p, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  const boss = await (await post("/v1/admin/members", ADMIN, { name: "Boss", role: "admin" })).json();
  const bdir = fs.mkdtempSync(os.tmpdir() + "/boss"); const bs = loadOrCreateSigner(bdir);
  fs.writeFileSync(bdir + "/config.json", JSON.stringify({ url, key: boss.key, id: boss.id, me: "Boss" }));
  await post("/v1/me/key", boss.key, { pubkey: bs.pubkey, enc_pubkey: bs.encPub, enc_sig: signEncKey(bs, boss.id) });
  const invite = async (name) => (await (await post("/v1/admin/invites", ADMIN, { name, kind: "server_agent" })).json()).code;
  env.DB.raw.exec("SELECT 1");
  const inbox = async () => JSON.parse(await sh("node", ["src/cli.mjs", "inbox"], { HOME: bdir, COMMUNITY_CONFIG_DIR: bdir })).messages;
  return { srv, url, invite, inbox, db: env.DB };
};

test("light install: installer joins as server agent, `community` sends signed labelled DM", async () => {
  const { srv, url, invite, inbox } = await boot();
  try {
    const home = fs.mkdtempSync(os.tmpdir() + "/home");
    const out = await sh("bash", ["scripts/install-agent.sh", url, await invite("Srv1"), "vps-light"], { HOME: home, COMMUNITY_BROKER_SOCKET: "/nonexistent/b.sock" });
    assert.match(out, /Light install done/);
    assert.ok(fs.existsSync(home + "/.claude/skills/community/SKILL.md"));
    assert.ok(fs.existsSync(home + "/.codex/skills/community/SKILL.md"));
    assert.equal(fs.statSync(home + "/.config/fab-community/config.json").mode & 0o777, 0o600);
    await sh(home + "/.local/bin/community", ["send", "Boss", "light works", "--via", "ci-bot"], { HOME: home, COMMUNITY_BROKER_SOCKET: "/nonexistent/b.sock" });
    const m = (await inbox())[0];
    assert.equal(m.text, "light works");
    assert.equal(m.via, "ci-bot");
    assert.equal(m.location, "vps-light"); // set by the wrapper
    assert.equal(m.signature, "verified");
    assert.equal(m.from, "Srv1");
    await assert.rejects(sh(home + "/.local/bin/community", ["send", "Nobody", "x"], { HOME: home }));
  } finally { srv.close(); }
});

test("hardened path: `community` uses the broker socket when it exists", async () => {
  const { srv, url, invite, inbox } = await boot();
  let broker;
  try {
    const adir = fs.mkdtempSync(os.tmpdir() + "/agentcfg");
    await sh("node", ["src/cli.mjs", "join", url, await invite("Srv2")], { HOME: adir, COMMUNITY_CONFIG_DIR: adir });
    fs.writeFileSync(adir + "/broker.json", JSON.stringify({ at: "vps-hard", recipients: ["Boss"], rate: { max: 5, window_s: 600 }, max_body: 500 }));
    const sock = fs.mkdtempSync(os.tmpdir() + "/s") + "/b.sock";
    broker = spawn("node", ["src/broker.mjs", "--config-dir", adir, "--socket", sock], { env: { PATH: process.env.PATH, HOME: adir }, stdio: "ignore" });
    for (let i = 0; i < 50 && !fs.existsSync(sock); i++) await new Promise((r) => setTimeout(r, 50));
    // the calling process has NO config dir: it can only succeed through the broker
    const clean = fs.mkdtempSync(os.tmpdir() + "/nocfg");
    await sh("node", ["src/agent.mjs", "send", "Boss", "via broker", "--via", "deploy-bot"], { HOME: clean, COMMUNITY_CONFIG_DIR: clean, COMMUNITY_BROKER_SOCKET: sock });
    const m = (await inbox())[0];
    assert.equal(m.text, "via broker");
    assert.equal(m.location, "vps-hard");
    assert.equal(m.via, "deploy-bot");
    await assert.rejects(sh("node", ["src/agent.mjs", "send", "Ada", "x"], { HOME: clean, COMMUNITY_CONFIG_DIR: clean, COMMUNITY_BROKER_SOCKET: sock }), /not allowed/);
    // without the socket and without a config the command fails: nothing to fall back to
    await assert.rejects(sh("node", ["src/agent.mjs", "who"], { HOME: clean, COMMUNITY_CONFIG_DIR: clean, COMMUNITY_BROKER_SOCKET: clean + "/none" }), /not set up/);
  } finally { broker?.kill(); srv.close(); }
});
