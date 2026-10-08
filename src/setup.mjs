import readline from "node:readline/promises";
import { loadConfig, saveConfig, api } from "./lib.mjs";
import { execFileSync } from "node:child_process";

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const cur = loadConfig() || {};
console.log("\n  Fab Community setup\n");
const url = (await rl.question(`  Community URL${cur.url ? ` [${cur.url}]` : ""}: `)).trim() || cur.url;
let key = (await rl.question("  Invite code (fci_…) or key (fck_…): ")).trim() || cur.key;
rl.close();
try {
  if (key.startsWith("fci_")) {
    const r = await fetch(url.replace(/\/$/, "") + "/v1/join", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: key }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    key = j.key; // personal key, minted for this machine only, never shown
  }
  const info = await fetch(url.replace(/\/$/, "") + "/v1/community").then((r) => r.json());
  const me = await api({ url, key }, "GET", "/v1/me");
  saveConfig({ url, key, community: info.name, me: me.name });
  console.log(`\n  ✓ ${info.name} — ${me.name} connected as.\n`);
  try { execFileSync(process.env.HERDR_BIN_PATH || "herdr", ["plugin", "action", "invoke", "community.open"]); } catch {}
} catch (e) {
  console.log(`\n  ✗ Could not connect: ${e.message}\n`);
  await new Promise((r) => setTimeout(r, 4000));
  process.exit(1);
}
await new Promise((r) => setTimeout(r, 1200));
