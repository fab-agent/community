import readline from "node:readline/promises";
import { loadConfig, saveConfig, api } from "./lib.mjs";
import { execFileSync } from "node:child_process";

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const cur = loadConfig() || {};
console.log("\n  Fab Community setup\n");
const url = (await rl.question(`  Community URL${cur.url ? ` [${cur.url}]` : ""}: `)).trim() || cur.url;
const key = (await rl.question("  Anahtar (key): ")).trim() || cur.key;
rl.close();
try {
  const info = await fetch(url.replace(/\/$/, "") + "/v1/community").then((r) => r.json());
  const me = await api({ url, key }, "GET", "/v1/me");
  saveConfig({ url, key, community: info.name, me: me.name });
  console.log(`\n  ✓ ${info.name} — ${me.name} olarak bağlandın.\n`);
  try { execFileSync(process.env.HERDR_BIN_PATH || "herdr", ["plugin", "action", "invoke", "community.open"]); } catch {}
} catch (e) {
  console.log(`\n  ✗ Bağlanılamadı: ${e.message}\n`);
  await new Promise((r) => setTimeout(r, 4000));
  process.exit(1);
}
await new Promise((r) => setTimeout(r, 1200));
