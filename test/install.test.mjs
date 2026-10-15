import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import worker, { INSTALLER_REF } from "../server/src/index.js";
import { makeDb } from "./d1-shim.mjs";
import { loadOrCreateSigner, signEncKey } from "../src/sign.mjs";

const ADMIN = "root-admin-key";
const root = new URL("..", import.meta.url).pathname;
const VERSION = fs.readFileSync(root + "scripts/install.sh", "utf8").match(/^VERSION="([^"]+)"/m)[1];
const sh = (cmd, env) => new Promise((res, rej) => execFile("sh", ["-c", cmd], { env: { PATH: process.env.PATH, ...env } }, (e, so, se) => e ? rej(Object.assign(new Error(se || e.message), { stderr: se })) : res(so + se)));

test("the Worker's INSTALLER_REF equals the package version", () => {
  assert.equal(INSTALLER_REF, "v" + JSON.parse(fs.readFileSync(root + "package.json", "utf8")).version);
});

test("install.sh VERSION matches the package and plugin manifest (bump all together)", () => {
  assert.equal(VERSION, "v" + JSON.parse(fs.readFileSync(root + "package.json", "utf8")).version);
  assert.match(fs.readFileSync(root + "herdr-plugin.toml", "utf8"), new RegExp(`^version = "${VERSION.slice(1).replaceAll(".", "\\.")}"`, "m"));
});

// A fake release directory: the archive built from this working tree plus its sha256, served over file://
function fakeRelease(tamper = false) {
  const dir = fs.mkdtempSync(os.tmpdir() + "/rel");
  const name = `community-${VERSION}.tar.gz`;
  execFileSync("tar", ["czf", `${dir}/${name}`, "--exclude=.git", "--exclude=node_modules", "--transform", `s,^\\.,community-${VERSION},`, "-C", root, "."]);
  const hex = crypto.createHash("sha256").update(fs.readFileSync(`${dir}/${name}`)).digest("hex");
  fs.writeFileSync(`${dir}/${name}.sha256`, `${tamper ? "0".repeat(64) : hex}  ${name}\n`);
  return dir;
}

async function boot() {
  const env = { DB: makeDb(), ADMIN_KEY: ADMIN, COMMUNITY_NAME: "t" };
  const srv = http.createServer(async (rq, rs) => {
    const chunks = []; for await (const c of rq) chunks.push(c);
    const r = await worker.fetch(new Request("http://x" + rq.url, { method: rq.method, headers: rq.headers, body: chunks.length ? Buffer.concat(chunks) : undefined }), env);
    rs.writeHead(r.status, { "content-type": "application/json" }); rs.end(await r.text());
  }).listen(0);
  await new Promise((r) => srv.on("listening", r));
  const url = `http://127.0.0.1:${srv.address().port}`;
  const post = (p, key, body) => fetch(url + p, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
  const boss = await post("/v1/admin/members", ADMIN, { name: "Boss", role: "admin" });
  const bdir = fs.mkdtempSync(os.tmpdir() + "/boss"); const bs = loadOrCreateSigner(bdir);
  fs.writeFileSync(bdir + "/config.json", JSON.stringify({ url, key: boss.key, id: boss.id, me: "Boss" }));
  await post("/v1/me/key", boss.key, { pubkey: bs.pubkey, enc_pubkey: bs.encPub, enc_sig: signEncKey(bs, boss.id) });
  return { srv, url, bdir, invite: async (name) => (await post("/v1/admin/invites", ADMIN, { name, kind: "server_agent" })).code };
}

test("one command: install.sh piped to sh installs, joins and sends a labelled message (no rsync needed)", async () => {
  const { srv, url, bdir, invite } = await boot();
  try {
    const home = fs.mkdtempSync(os.tmpdir() + "/home"), rel = fakeRelease();
    const env = { HOME: home, COMMUNITY_RELEASE_BASE: "file://" + rel, COMMUNITY_SKIP_ATTEST: "1", COMMUNITY_BROKER_SOCKET: "/nonexistent/b.sock" };
    const out = await sh(`cat ${root}scripts/install.sh | sh -s -- ${url} ${await invite("Srv1")} one-liner`, env);
    assert.match(out, /Light install done/);
    await sh(`${home}/.local/bin/community send Boss "installed in one line" --via setup`, env);

    const msgs = JSON.parse(await sh(`node ${root}src/cli.mjs inbox`, { HOME: bdir, COMMUNITY_CONFIG_DIR: bdir })).messages; // async: the in-process Worker must keep answering
    assert.equal(msgs[0].text, "installed in one line");
    assert.equal(msgs[0].location, "one-liner");
    assert.equal(msgs[0].signature, "verified");
  } finally { srv.close(); }
});

test("install.sh refuses a checksum mismatch and a missing invite, and installs nothing", async () => {
  const home = fs.mkdtempSync(os.tmpdir() + "/home"), rel = fakeRelease(true);
  const env = { HOME: home, COMMUNITY_RELEASE_BASE: "file://" + rel, COMMUNITY_SKIP_ATTEST: "1" };
  await assert.rejects(sh(`sh ${root}scripts/install.sh http://127.0.0.1:1 fci_x lbl`, env), /checksum mismatch/);
  assert.equal(fs.existsSync(home + "/.local/bin/community"), false);
  await assert.rejects(sh(`sh ${root}scripts/install.sh http://127.0.0.1:1`, env), /usage/);
  await assert.rejects(sh(`sh ${root}scripts/install.sh http://127.0.0.1:1 fci_x lbl --hardened`, { ...env }), /needs root|checksum/);
});

test("`community who` shows kind and no online flag for servers", async () => {
  const { srv, url, bdir, invite } = await boot();
  try {
    const home = fs.mkdtempSync(os.tmpdir() + "/home"), rel = fakeRelease();
    const env = { HOME: home, COMMUNITY_RELEASE_BASE: "file://" + rel, COMMUNITY_SKIP_ATTEST: "1", COMMUNITY_BROKER_SOCKET: "/nonexistent/b.sock" };
    await sh(`sh ${root}scripts/install.sh ${url} ${await invite("Srv1")} lbl`, env);
    const who = JSON.parse(await sh(`node ${root}src/cli.mjs who`, { HOME: bdir, COMMUNITY_CONFIG_DIR: bdir }));
    const srvRow = who.find((m) => m.name === "Srv1"), human = who.find((m) => m.name === "Boss");
    assert.equal(srvRow.kind, "server_agent");
    assert.equal("online" in srvRow, false);
    assert.equal(human.kind, "human");
    assert.equal(typeof human.online, "boolean");
  } finally { srv.close(); }
});
