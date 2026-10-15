// TUI smoke test: run src/chat.mjs in a 110x40 pty against the in-process Worker and a fake `herdr`.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import { execFile, execFileSync } from "node:child_process";
import worker from "../server/src/index.js";
import { makeDb } from "./d1-shim.mjs";
import { loadOrCreateSigner, signEncKey } from "../src/sign.mjs";

const ADMIN = "root-admin-key";
let havePty = true;
try { execFileSync("python3", ["-c", "import pty"]); } catch { havePty = false; }

const strip = (s) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "");
const lastFrame = (raw) => strip(raw.split("\x1b[H").pop());

async function boot(extraCfg = {}) {
  const env = { DB: makeDb(), ADMIN_KEY: ADMIN, COMMUNITY_NAME: "t" };
  const srv = http.createServer(async (rq, rs) => {
    const chunks = []; for await (const c of rq) chunks.push(c);
    const r = await worker.fetch(new Request("http://x" + rq.url, { method: rq.method, headers: rq.headers, body: chunks.length ? Buffer.concat(chunks) : undefined }), env);
    rs.writeHead(r.status, { "content-type": "application/json" }); rs.end(await r.text());
  }).listen(0);
  await new Promise((r) => srv.on("listening", r));
  const url = `http://127.0.0.1:${srv.address().port}`;
  const boss = await (await fetch(url + "/v1/admin/members", { method: "POST", headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" }, body: JSON.stringify({ name: "Boss", role: "admin" }) })).json();
  const dir = fs.mkdtempSync(os.tmpdir() + "/tui"); const s = loadOrCreateSigner(dir);
  fs.writeFileSync(dir + "/config.json", JSON.stringify({ url, key: boss.key, id: boss.id, me: "Boss", community: "t", ...extraCfg }));
  await fetch(url + "/v1/me/key", { method: "POST", headers: { authorization: `Bearer ${boss.key}`, "content-type": "application/json" }, body: JSON.stringify({ pubkey: s.pubkey, enc_pubkey: s.encPub, enc_sig: signEncKey(s, boss.id) }) });
  const log = dir + "/herdr.log"; fs.writeFileSync(log, "");
  const bin = dir + "/herdr"; fs.writeFileSync(bin, `#!/bin/sh\nexec ${process.execPath} ${new URL("./helpers/fake-herdr.mjs", import.meta.url).pathname} "$@"\n`, { mode: 0o755 });
  const run = (steps, secs = 4) => new Promise((res, rej) => execFile("python3", ["-I", new URL("./helpers/pty-run.py", import.meta.url).pathname, String(secs), "40", "110", JSON.stringify(steps), "--", process.execPath, "src/chat.mjs"],
    { encoding: "utf8", maxBuffer: 1 << 24, env: { PATH: process.env.PATH, HOME: dir, COMMUNITY_CONFIG_DIR: dir, HERDR_BIN_PATH: bin, FAKE_HERDR_LOG: log, TERM: "xterm-256color" } }, (e, so) => e ? rej(e) : res(so)));
  return { srv, dir, log, run, env };
}

test("Agents: Local plus opted-in machines; others are off, disabled hidden, failures are one short line", { skip: !havePty }, async () => {
  const { srv, run, log } = await boot({ share_machines: ["build-box", "flaky"] });
  try {
    const screen = lastFrame(await run([[1.2, "\x1b[C"], [0.3, "\x1b[C"]], 4));
    assert.match(screen, /Local\b/);
    assert.match(screen, /LocalWork · claude/);
    assert.match(screen, /Machine build-box/);
    assert.match(screen, /RemoteWork · claude/);
    assert.match(screen, /Machine flaky[\s\S]*unavailable: .*unreachable/);
    assert.match(screen, /Machine demo-srv[\s\S]*sharing off/);
    assert.ok(!/old-box/.test(screen), "disabled machine must not be listed");
    const calls = fs.readFileSync(log, "utf8");
    assert.ok(!/demo-srv/.test(calls.replace(/\["machine","list"[^\n]*\n/g, "")), "a machine that is not opted in is never queried");
  } finally { srv.close(); }
});

test("remote share preview says remote machine and redacts harder; nothing is sent before Enter", { skip: !havePty }, async () => {
  const { srv, run, env } = await boot({ share_machines: ["build-box"] });
  try {
    await env.DB.prepare("INSERT INTO members (id,name,role,key_hash,created_at) VALUES ('ada1','Ada','member','x',0)").run();
    // Agents tab, down to the remote agent, Enter = menu, down = "recent output", Enter, pick Ada, Enter -> preview (not sent)
    const raw = await run([[1.2, "\x1b[C"], [0.3, "\x1b[C"], [0.4, "\x1b[B"], [0.3, "\r"], [0.3, "\x1b[B"], [0.3, "\r"], [0.4, "\r"]], 5);
    const screen = lastFrame(raw);
    assert.match(screen, /Send to Ada\?/);
    assert.match(screen, /REMOTE MACHINE build-box · stricter redaction applied/);
    assert.match(screen, /machine "build-box"/);
    assert.ok(!/10\.1\.2\.3|ada@example|\/home\/ada/.test(screen), screen);
    assert.match(screen, /Enter: send/);
    assert.equal((await env.DB.prepare("SELECT COUNT(*) n FROM messages").first()).n, 0);
  } finally { srv.close(); }
});

test("/invite … | server shows the code and both install commands", { skip: !havePty }, async () => {
  const { srv, run } = await boot();
  try {
    const screen = lastFrame(await run([[1.2, "/invite Build-box | | | server\r"]], 3.5));
    assert.match(screen, /Invite for server "Build-box"/);
    assert.match(screen, /code: fci_/);
    assert.match(screen.replace(/\s+/g, ' '), /scripts\/install-agent\.sh http:\/\/127\.0\.0\.1:\d+ fci_\S+ <machine- ?label>/); // long lines wrap, never cut
    assert.match(screen, /sudo scripts\/install-broker\.sh/);
  } finally { srv.close(); }
});

test("/at sets and clears a location label in config", { skip: !havePty }, async () => {
  const { srv, run, dir } = await boot();
  try {
    await run([[1.2, "/at Lab-laptop\r"]], 2.5);
    assert.equal(JSON.parse(fs.readFileSync(dir + "/config.json", "utf8")).location, "Lab-laptop");
    await run([[1.2, "/at off\r"]], 2.5);
    assert.equal(JSON.parse(fs.readFileSync(dir + "/config.json", "utf8")).location, undefined);
  } finally { srv.close(); }
});

test("/pull refuses a remote machine target", { skip: !havePty }, async () => {
  const { srv, run, log } = await boot();
  try {
    // no message exists yet -> "no messages yet" would fire first, so seed last.json
    fs.mkdirSync(log.replace("herdr.log", "state"), { recursive: true });
    fs.writeFileSync(log.replace("herdr.log", "state/last.json"), JSON.stringify({ from_name: "Ada", body: "hi" }));
    const screen = strip(await run([[1.2, "/pull build-box/w1:p7\r"]], 3));
    assert.match(screen, /cannot paste into a remote machine/);
    assert.ok(!/send-text/.test(fs.readFileSync(log, "utf8")));
  } finally { srv.close(); }
});
