// Update notice: once every 24 h ask GitHub for the latest release and compare with the installed version.
// Opt out with "update_check": false in the plugin config. Only the public releases endpoint is contacted.
import fs from "node:fs";
import path from "node:path";

export const REPO = "fab-agent/community";
const parse = (v) => String(v).replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
export function newer(latest, current) {
  const a = parse(latest), b = parse(current);
  for (let i = 0; i < 3; i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  return false;
}
export function installedVersion(root) {
  try { return fs.readFileSync(path.join(root, "herdr-plugin.toml"), "utf8").match(/^version\s*=\s*"([^"]+)"/m)[1]; } catch { return null; }
}
// Returns the newer version string, or null. `store` = { read(), write(obj) } for the 6 h cache.
export async function checkUpdate(current, store, fetchFn = fetch, now = Date.now()) {
  if (!current) return null;
  let c = store.read() || {};
  if (!c.at || now - c.at > 24 * 3_600_000) {
    try {
      const r = await fetchFn(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { accept: "application/vnd.github+json", "user-agent": "herdr-community" } });
      if (r.ok) c = { at: now, latest: String((await r.json()).tag_name || "") };
      else c = { ...c, at: now };
    } catch { c = { ...c, at: now }; }
    store.write(c);
  }
  return c.latest && newer(c.latest, current) ? c.latest.replace(/^v/, "") : null;
}
