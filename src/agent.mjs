// Single entry point for agents on a server:  community <who|inbox|send|topics|read|post> ... [--via <agent-name>]
// If a broker socket exists (hardened install) the request goes through it and this process never sees the key;
// otherwise it runs src/cli.mjs directly with the key in the config directory (light install).
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const take = (n) => { const i = argv.indexOf(n); return i < 0 ? null : argv.splice(i, 2)[1]; };
const via = take("--via") ?? process.env.COMMUNITY_VIA ?? "";
const sock = process.env.COMMUNITY_BROKER_SOCKET || "/run/community-broker/broker.sock";
const [cmd, ...rest] = argv;

const viaBroker = (req) => new Promise((resolve, reject) => {
  const c = net.connect(sock, () => c.write(JSON.stringify(req) + "\n"));
  let b = ""; c.on("data", (d) => (b += d)); c.on("end", () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } }); c.on("error", reject);
});
const request = () => {
  const since = take2("--since");
  const base = { cmd, via };
  if (cmd === "send") return { ...base, to: rest[0], text: rest.slice(1).join(" ") };
  if (cmd === "post") return { ...base, topic: rest[0], text: rest.slice(1).join(" ") };
  if (cmd === "read") return { ...base, topic: rest[0], since };
  if (cmd === "inbox") return { ...base, since };
  return base;
};
function take2(n) { const i = rest.indexOf(n); return i < 0 ? undefined : rest.splice(i, 2)[1]; }

if (!cmd) { console.error("usage: community <who|inbox|send|topics|read|post> ... [--via <agent-name>]"); process.exit(2); }

let useBroker = false;
try { useBroker = fs.statSync(sock).isSocket(); } catch {}
if (useBroker) {
  try {
    const r = await viaBroker(request());
    if (!r.ok) { console.error(r.error + (r.retry_after ? ` (retry in ${r.retry_after}s)` : "")); process.exit(1); }
    console.log(JSON.stringify(r.redacted ? { ...r.result, redacted: r.redacted } : r.result, null, 2));
    process.exit(0);
  } catch (e) { console.error("broker unreachable: " + e.message); process.exit(1); }
}
const child = spawn(process.execPath, [path.join(here, "cli.mjs"), cmd, "--via", via, ...rest], { stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 1));
