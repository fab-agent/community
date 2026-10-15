// Community broker: the only process on a server that holds the Server Agent's key.
// Sub-agents talk to it over a unix socket (one JSON request per connection, one JSON reply):
//   {"cmd":"send","to":"Name","text":"...","via":"deploy-bot"}   {"cmd":"post","topic":3,"text":"..."}
//   {"cmd":"inbox","since":0}  {"cmd":"who"}  {"cmd":"topics"}  {"cmd":"read","topic":3,"since":0}
// It applies local policy (recipient allowlist, rate, size, secret redaction) before the Worker's own policy,
// and stamps every message with the machine label. `via` is declared by the caller: a label, not a proof.
// Real key secrecy needs the broker to run as a different OS user than the agents (see scripts/install-broker.sh).
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { redact } from "./share.mjs";

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "cli.mjs");
const arg = (n, d) => { const i = process.argv.indexOf(n); return i < 0 ? d : process.argv[i + 1]; };
const configDir = arg("--config-dir", process.env.COMMUNITY_CONFIG_DIR || path.join(process.env.HOME || ".", ".config", "fab-community"));
const socketPath = arg("--socket", "/run/community-broker/broker.sock");

let policy = { at: "", recipients: null, rate: { max: 10, window_s: 60 }, max_body: 2000 };
try { policy = { ...policy, ...JSON.parse(fs.readFileSync(path.join(configDir, "broker.json"), "utf8")) }; } catch {}

const WRITE = new Set(["send", "post"]), READ = new Set(["inbox", "who", "topics", "read"]);
const sent = []; // timestamps for the sliding window
const label = (v) => String(v ?? "").replace(/[\x00-\x1f\x7f-\x9f]+/g, " ").trim().slice(0, 60);
const run = (args) => new Promise((resolve) => execFile(process.execPath, [cli, ...args], {
  env: { PATH: process.env.PATH, HOME: process.env.HOME, COMMUNITY_CONFIG_DIR: configDir }, timeout: 15000, maxBuffer: 2_000_000,
}, (e, so, se) => resolve(e ? { ok: false, error: String(se || e.message).trim().split("\n").pop() } : { ok: true, result: JSON.parse(so || "null") })));

async function handle(req) {
  const cmd = String(req.cmd);
  if (!WRITE.has(cmd) && !READ.has(cmd)) return { ok: false, error: "unknown command" };
  // The caller's labels always come first in argv, so text that happens to contain "--via" cannot override them.
  const lab = ["--via", label(req.via), "--at", label(policy.at)];
  if (READ.has(cmd)) {
    const extra = cmd === "read" ? [String(Number(req.topic))] : [];
    if ((cmd === "inbox" || cmd === "read") && req.since !== undefined) extra.push("--since", String(Number(req.since) || 0));
    return run([cmd, ...lab, ...extra]);
  }
  const now = Date.now();
  while (sent.length && now - sent[0] > policy.rate.window_s * 1000) sent.shift();
  if (sent.length >= policy.rate.max) return { ok: false, error: "broker rate limit", retry_after: Math.ceil((sent[0] + policy.rate.window_s * 1000 - now) / 1000) };
  const text0 = String(req.text ?? "").trim();
  if (!text0) return { ok: false, error: "empty message" };
  if (text0.length > policy.max_body) return { ok: false, error: "message too large" };
  const { text, count } = redact(text0);
  let target;
  if (cmd === "send") {
    const to = String(req.to ?? "").trim();
    if (!to) return { ok: false, error: "recipient required" };
    if (policy.recipients && !policy.recipients.map((n) => n.toLowerCase()).includes(to.toLowerCase())) return { ok: false, error: "recipient not allowed by broker policy" };
    target = [to];
  } else target = [String(Number(req.topic))];
  sent.push(now);
  const r = await run([cmd, ...lab, ...target, text]);
  return count ? { ...r, redacted: count } : r;
}

const server = net.createServer((sock) => {
  let buf = "";
  sock.setTimeout(20000, () => sock.destroy());
  sock.on("data", async (d) => {
    buf += d;
    if (buf.length > 16384) { sock.end(JSON.stringify({ ok: false, error: "request too large" }) + "\n"); return; }
    const nl = buf.indexOf("\n");
    if (nl < 0) return;
    sock.removeAllListeners("data");
    let req; try { req = JSON.parse(buf.slice(0, nl)); } catch { return sock.end(JSON.stringify({ ok: false, error: "bad json" }) + "\n"); }
    sock.end(JSON.stringify(await handle(req)) + "\n");
  });
  sock.on("error", () => {});
});
// Presence: the broker is the server's heartbeat, so the member shows as online while the service runs
// (the Worker marks a member online for 90 s after its last authenticated request).
try {
  const c = JSON.parse(fs.readFileSync(path.join(configDir, "config.json"), "utf8"));
  const beat = () => fetch(c.url.replace(/\/$/, "") + "/v1/me", { headers: { authorization: `Bearer ${c.key}` } }).catch(() => {});
  beat(); setInterval(beat, 45_000).unref();
} catch {}
fs.mkdirSync(path.dirname(socketPath), { recursive: true });
try { fs.unlinkSync(socketPath); } catch {}
server.listen(socketPath, () => { fs.chmodSync(socketPath, 0o660); console.error(`community-broker listening on ${socketPath}`); });
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { server.close(); try { fs.unlinkSync(socketPath); } catch {} process.exit(0); });
