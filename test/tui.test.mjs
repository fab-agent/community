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
  const run = (steps, secs = 4, size = [40, 110]) => new Promise((res, rej) => execFile("python3", ["-I", new URL("./helpers/pty-run.py", import.meta.url).pathname, String(secs), String(size[0]), String(size[1]), JSON.stringify(steps), "--", process.execPath, "src/chat.mjs"],
    { encoding: "utf8", maxBuffer: 1 << 24, env: { PATH: process.env.PATH, HOME: dir, COMMUNITY_CONFIG_DIR: dir, HERDR_BIN_PATH: bin, FAKE_HERDR_LOG: log, TERM: "xterm-256color" } }, (e, so) => e ? rej(e) : res(so)));
  return { srv, dir, log, run, env };
}

test("Agents: Local plus opted-in machines; others are off, disabled hidden, failures are one short line", { skip: !havePty }, async () => {
  const { srv, run, log } = await boot({ share_machines: ["build-box", "flaky", "oldver"] });
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

test("/invite … | server shows the code and the one-line install commands", { skip: !havePty }, async () => {
  const { srv, run } = await boot();
  try {
    const screen = lastFrame(await run([[1.2, "/invite Build-box | | | server\r"]], 3.5));
    assert.match(screen, /Invite for server "Build-box"/);
    assert.match(screen, /code: fci_/);
    const flat = screen.replace(/\s+/g, " ");
    assert.match(flat, /curl -fsSL http:\/\/127\.0\.0\.1:\d+\/install\/fci_\w+ \| sh/);
    assert.match(flat, /\?hardened=1" \| sudo sh/);
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

// Lines of one machine group: from its "Machine <label>" header to the next header or the separator.
const group = (screen, label) => {
  const ls = strip(screen).split(/\r?\n/); const i = ls.findIndex((l) => l.includes(`Machine ${label}`));
  assert.ok(i >= 0, `no group for ${label}`);
  const out = []; for (let j = i + 1; j < ls.length && !/Machine |^─/.test(ls[j]); j++) if (ls[j].trim()) out.push(ls[j]);
  return out;
};

for (const [label, note] of [["flaky", /unavailable: .*unreachable/], ["oldver", /unavailable: .*does not support --machine/]]) {
  test(`machine failure (${label}): one short note, Local unaffected, no retry, nothing to share from it`, { skip: !havePty }, async () => {
    const { srv, run, log } = await boot({ share_machines: ["build-box", label] });
    try {
      const screen = lastFrame(await run([[1.2, "\x1b[C"], [0.3, "\x1b[C"]], 4));
      const g = group(screen, label);
      assert.equal(g.length, 1, g.join("|"));
      assert.match(g[0], note);
      assert.ok(g[0].trim().length <= 3 + "unavailable: ".length + 60, "note stays short");
      assert.match(screen, /LocalWork · claude/);
      assert.match(group(screen, "build-box").join("\n"), /RemoteWork · claude/); // healthy machine still listed
      const calls = fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      const mine = calls.filter((c) => c[0] === "--machine" && c[1] === label);
      assert.ok(mine.length > 0 && mine.every((c) => c.slice(2).join(" ") === "workspace list"), "stops at the first failing call: " + JSON.stringify(mine));
      // the failing machine is queried once per refresh, never twice in a row (no retry)
      for (let i = 1; i < calls.length; i++) assert.ok(!(calls[i].join() === calls[i - 1].join() && calls[i][1] === label), "retried");
      // only selectable agents are the healthy ones; the failing group has none, so nothing can be shared from it
      const menu = lastFrame(await run([[1.2, "\x1b[C"], [0.3, "\x1b[C"], [0.3, "\r"]], 4));
      assert.match(menu, /Share status of LocalWork · claude/); // the menu opened, on a healthy agent
      assert.ok(!menu.split(/\r?\n/).filter((l) => /Share (status|recent)/.test(l)).some((l) => l.includes(label)), "menu offers nothing from the failing machine");
    } finally { srv.close(); }
  });
}

test("/mouse off persists and stops mouse reporting; /invite copies the install command (OSC 52)", { skip: !havePty }, async () => {
  const { srv, run, dir } = await boot();
  try {
    const raw = await run([[1.2, "/mouse off\r"]], 2.5);
    assert.equal(JSON.parse(fs.readFileSync(dir + "/config.json", "utf8")).mouse, false);
    assert.ok(raw.includes("\x1b[?1000l")); // reporting switched off
    const next = await run([], 1.5); // a fresh start must not turn it back on
    assert.ok(!next.includes("\x1b[?1000h"));
    const inv = await run([[1.2, "/invite Box | | | server\r"]], 3.5);
    const m = inv.match(/\x1b\]52;c;([A-Za-z0-9+/=]+)\x07/);
    assert.ok(m, "OSC 52 clipboard sequence emitted");
    assert.match(Buffer.from(m[1], "base64").toString(), /^curl -fsSL http:\/\/127\.0\.0\.1:\d+\/install\/fci_\w+ \| sh$/);
  } finally { srv.close(); }
});

// ---- split layout ----------------------------------------------------------------
async function seed(env) {
  // straight into the DB: the API allows one new topic per 30 s per member
  env.DB.raw.exec("INSERT INTO members (id,name,role,key_hash,created_at) VALUES ('ada1','Ada','member','x',0)");
  const now = Date.now();
  for (const [i, title] of [[1, "Release planning"], [2, "İstanbul toplantısı"], [3, "Incident notes"]]) env.DB.raw.prepare("INSERT INTO topics (id,title,created_by,created_at) VALUES (?,?,?,?)").run(i, title, "ada1", now - 1000 * i);
  env.DB.raw.prepare("INSERT INTO messages (from_id,to_id,body,created_at,topic_id) VALUES ('ada1','','see you at ten',?,2)").run(now);
}

test("wide terminal: list and conversation side by side; narrow terminal keeps the single view", { skip: !havePty }, async () => {
  const { srv, run, env } = await boot();
  try {
    await env.DB.prepare("INSERT INTO members (id,name,role,key_hash,created_at) VALUES ('ada1','Ada','member','x',0)").run();
    const wide = lastFrame(await run([[1.3, "\x1b[B"]], 3, [40, 110]));
    assert.match(wide, /Boss ★ \(you\)\s+│/);   // list column, divider
    assert.match(wide, /│ (Ada|Boss)/);            // conversation heading on the right
    const narrow = lastFrame(await run([[1.3, "\x1b[B"]], 3, [24, 80]));
    assert.ok(!/│/.test(narrow), "no divider on a narrow screen");
    assert.match(narrow, /↑↓ select · Enter open/);
  } finally { srv.close(); }
});

test("Ctrl+→ / Ctrl+← resize the divider and the width is saved", { skip: !havePty }, async () => {
  const { srv, run, dir } = await boot();
  try {
    await run([[1.3, "\x1b[1;5C"], [0.2, "\x1b[1;5C"], [0.2, "\x1b[1;5C"]], 3.2);
    const w1 = JSON.parse(fs.readFileSync(dir + "/config.json", "utf8")).split;
    assert.equal(w1, 24 + 6 + 9); // default 30 % of 110 = 33, +2 per press (clamped later)
  } finally { srv.close(); }
});

test("dragging the divider with the mouse resizes it; a double click restores the default", { skip: !havePty }, async () => {
  const { srv, run, dir } = await boot();
  try {
    // divider is at column 34 (default list width 33): press there, move to column 51, release
    await run([[1.3, "\x1b[<0;34;5M"], [0.2, "\x1b[<32;42;5M"], [0.2, "\x1b[<32;51;5M"], [0.2, "\x1b[<0;51;5m"]], 3.2);
    assert.equal(JSON.parse(fs.readFileSync(dir + "/config.json", "utf8")).split, 50);
    await run([[1.3, "\x1b[<0;51;5M"], [0.05, "\x1b[<0;51;5m"], [0.1, "\x1b[<0;51;5M"], [0.05, "\x1b[<0;51;5m"]], 3);
    assert.equal(JSON.parse(fs.readFileSync(dir + "/config.json", "utf8")).split, undefined);
    // a drag can never squeeze the conversation below 40 columns
    await run([[1.3, "\x1b[<0;34;5M"], [0.2, "\x1b[<32;105;5M"], [0.2, "\x1b[<0;105;5m"]], 3.2);
    assert.equal(JSON.parse(fs.readFileSync(dir + "/config.json", "utf8")).split, 110 - 40 - 1);
  } finally { srv.close(); }
});

test("/find filters Discussions by title live (Turkish letters folded), Esc clears", { skip: !havePty }, async () => {
  const { srv, run, env } = await boot();
  try {
    await seed(env);
    const live = lastFrame(await run([[1.3, "\x1b[C"], [0.8, "/find istanbul"]], 3.6));
    assert.match(live, /İstanbul toplantısı/);
    assert.ok(!/Release planning/.test(live) && !/Incident notes/.test(live), live);
    const cleared = lastFrame(await run([[1.3, "\x1b[C"], [0.5, "/find incident\r"], [0.6, "\x1b"]], 4));
    assert.match(cleared, /Release planning/);
    assert.match(cleared, /Incident notes/);
    const none = lastFrame(await run([[1.3, "\x1b[C"], [0.8, "/find zzzz"]], 3.4));
    assert.match(none, /No discussion matches/);
  } finally { srv.close(); }
});

test("wide layout: selecting a discussion shows its messages without opening it", { skip: !havePty }, async () => {
  const { srv, run, env } = await boot();
  try {
    await seed(env);
    const frame = lastFrame(await run([[1.3, "\x1b[C"], [0.6, "/find istanbul"], [0.6, "\r"]], 4.2));
    assert.match(frame, /see you at ten/);
    assert.match(frame, /│ # İstanbul toplantısı/);
  } finally { srv.close(); }
});
