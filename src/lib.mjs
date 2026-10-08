import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const PLUGIN_ID = "community";
export const herdrBin = () => process.env.HERDR_BIN_PATH || "herdr";

export function configDir() {
  const d = process.env.HERDR_PLUGIN_CONFIG_DIR ||
    execFileSync(herdrBin(), ["plugin", "config-dir", PLUGIN_ID], { encoding: "utf8" }).trim();
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
}
export function stateDir() {
  const d = process.env.HERDR_PLUGIN_STATE_DIR || path.join(configDir(), "state");
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
}
const cfgFile = () => path.join(configDir(), "config.json");

export function loadConfig() {
  try { return JSON.parse(fs.readFileSync(cfgFile(), "utf8")); } catch { return null; }
}
export function saveConfig(c) {
  fs.writeFileSync(cfgFile(), JSON.stringify(c, null, 2), { mode: 0o600 });
  fs.chmodSync(cfgFile(), 0o600);
}

export async function api(cfg, method, p, body) {
  const res = await fetch(cfg.url.replace(/\/$/, "") + p, {
    method,
    headers: { authorization: `Bearer ${cfg.key}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export function herdr(args) {
  const out = execFileSync(herdrBin(), args, { encoding: "utf8" });
  try { return JSON.parse(out); } catch { return out; }
}
export const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(stateDir(), f), "utf8")); } catch { return d; } };
export const writeJson = (f, v) => fs.writeFileSync(path.join(stateDir(), f), JSON.stringify(v));
