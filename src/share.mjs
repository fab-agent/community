// Helpers for sharing an agent's status or recent output with a teammate. Pure functions, no I/O.
import { clean } from "./lib.mjs";

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g;
export const stripAnsi = (s) => String(s ?? "").replace(ANSI, "");

// Best-effort secret redaction. This is a safety net, not a guarantee: the human still reviews the preview.
const SECRET = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g,
  /\bBearer\s+[A-Za-z0-9._~+\/=-]{16,}/gi,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bfck_[A-Za-z0-9_-]{10,}/g,
  /\b(?:api[_-]?key|secret|token|passw(?:or)?d|authorization)\b\s*[:=]\s*["']?[^\s"']{6,}/gi,
  /\b[A-Za-z0-9_-]{40,}\b/g,
];
// Extra pass for output that comes from another machine: addresses, hostnames, user paths, long hex ids.
const STRICT = [
  /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g,
  /\b\d{1,3}(?:\.\d{1,3}){3}\b/g,
  /\b[0-9a-fA-F:]{2,}:[0-9a-fA-F:]{2,}\b(?=[^\w]|$)/g,
  /\b(?:[a-z0-9-]+\.)+(?:internal|local|lan|corp|net|com|org|io|dev|cloud)\b/gi,
  /\b[0-9a-fA-F]{20,}\b/g,
  /\bhttps?:\/\/\S+/gi,
];
const HOME = /(?:\/home|\/Users)\/[^/\s]+/g;
export function redact(text, { strict = false } = {}) {
  let n = 0, out = String(text);
  for (const re of SECRET) out = out.replace(re, () => { n++; return "[redacted]"; });
  if (strict) {
    for (const re of STRICT) out = out.replace(re, () => { n++; return "[redacted]"; });
    out = out.replace(HOME, () => { n++; return "~"; });
  }
  return { text: out, count: n };
}

// Agents = panes herdr recognises as an agent, minus our own Community panes.
export function listAgents(panes, wsName, machine = null) {
  return panes
    .filter((p) => p.agent && p.label !== "Community" && !String(wsName[p.workspace_id] ?? "").startsWith("▣"))
    .map((p) => ({
      id: p.pane_id, machine, key: machine ? `${machine}\u0000${p.pane_id}` : p.pane_id, agent: p.agent, status: p.agent_status || "unknown",
      title: oneLine(p.terminal_title_stripped || ""), workspace: oneLine(wsName[p.workspace_id] ?? p.workspace_id),
    }));
}
const oneLine = (s) => clean(s).replace(/\s+/g, " ").trim();

// What leaves this machine about a remote source: workspace name goes through the strict pass, and a machine label
// that looks like a host name or address is replaced. Local sources are unchanged.
const looksLikeHost = (l) => /[.:]/.test(l) || redact(l, { strict: true }).count > 0;
export const safeMachine = (label) => (looksLikeHost(String(label)) ? "remote" : String(label));
const safeWorkspace = (a) => (a.machine ? redact(a.workspace, { strict: true }).text : a.workspace);

export const agentCard = (a) => {
  const t = redact(a.title, { strict: !!a.machine });
  return `🤖 ${a.agent} · ${a.status} · ${a.machine ? `machine "${safeMachine(a.machine)}" · ` : ""}workspace "${safeWorkspace(a)}"` + (t.text ? `\n${t.text}` : "");
};

// Machines you may share from: saved, enabled, and opted in by name in config (`share_machines`). Off by default.
export const sharedMachines = (cfg) => (Array.isArray(cfg?.share_machines) ? cfg.share_machines.map(String) : []);
export function planMachines(saved, cfg) {
  const on = new Set(sharedMachines(cfg));
  const usable = (Array.isArray(saved) ? saved : []).filter((m) => m && m.enabled !== false && m.label);
  return { shared: usable.filter((m) => on.has(m.label)).map((m) => m.label), off: usable.filter((m) => !on.has(m.label)).map((m) => m.label) };
}

// Flat, displayable rows: a header per group ("Local", one per machine) followed by its agents or a short note.
export function agentRows(groups) {
  const rows = [];
  for (const g of groups) {
    rows.push({ header: g.machine ? `Machine ${g.machine}` : "Local" });
    if (g.note) rows.push({ note: g.note });
    for (const a of g.agents ?? []) rows.push({ agent: a });
  }
  return rows;
}

// /pull always writes into this client's own panes. Refuse anything that names a remote machine or is not a local pane.
export function pullTarget(arg, localPaneIds, machineLabels = []) {
  const a = String(arg ?? "").trim();
  if (!a) return { ok: false, reason: "no pane given" };
  if (machineLabels.some((l) => a === l || a.startsWith(l + "/") || a.startsWith(l + "\u0000")) || /[\/\u0000]/.test(a)) return { ok: false, reason: "/pull cannot paste into a remote machine" };
  if (!localPaneIds.includes(a)) return { ok: false, reason: "not a pane on this machine" };
  return { ok: true };
}

// Recent terminal output of one pane, reduced to something readable and short.
export function outputExcerpt(raw, { lines = 40, max = 3000, strict = false } = {}) {
  const ls = stripAnsi(raw).split("\n").map((l) => clean(l).replace(/\s+$/, ""))
    .filter((l) => !/^[─━═╌╍\s]+$/.test(l) || l === "");
  while (ls.length && !ls[ls.length - 1]) ls.pop();
  while (ls.length && !ls[0]) ls.shift();
  let text = ls.slice(-lines).join("\n");
  const r = redact(text, { strict });
  text = r.text;
  const cut = text.length > max;
  if (cut) text = "…" + text.slice(-max);
  return { text, redacted: r.count, truncated: cut };
}
export const outputMessage = (a, ex) => `🤖 output of ${a.agent} (${a.machine ? `machine "${safeMachine(a.machine)}", ` : ""}workspace "${safeWorkspace(a)}", ${a.status}), shared by hand and cleaned of obvious secrets:\n${ex.text}`;
