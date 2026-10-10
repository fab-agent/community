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
export function redact(text) {
  let n = 0, out = String(text);
  for (const re of SECRET) out = out.replace(re, () => { n++; return "[redacted]"; });
  return { text: out, count: n };
}

// Agents = panes herdr recognises as an agent, minus our own Community panes.
export function listAgents(panes, wsName) {
  return panes
    .filter((p) => p.agent && p.label !== "Community" && !String(wsName[p.workspace_id] ?? "").startsWith("▣"))
    .map((p) => ({
      id: p.pane_id, agent: p.agent, status: p.agent_status || "unknown",
      title: oneLine(p.terminal_title_stripped || ""), workspace: oneLine(wsName[p.workspace_id] ?? p.workspace_id),
    }));
}
const oneLine = (s) => clean(s).replace(/\s+/g, " ").trim();

export const agentCard = (a) => {
  const t = redact(a.title);
  return `🤖 ${a.agent} · ${a.status} · workspace "${a.workspace}"` + (t.text ? `\n${t.text}` : "");
};

// Recent terminal output of one pane, reduced to something readable and short.
export function outputExcerpt(raw, { lines = 40, max = 3000 } = {}) {
  const ls = stripAnsi(raw).split("\n").map((l) => clean(l).replace(/\s+$/, ""))
    .filter((l) => !/^[─━═╌╍\s]+$/.test(l) || l === "");
  while (ls.length && !ls[ls.length - 1]) ls.pop();
  while (ls.length && !ls[0]) ls.shift();
  let text = ls.slice(-lines).join("\n");
  const r = redact(text);
  text = r.text;
  const cut = text.length > max;
  if (cut) text = "…" + text.slice(-max);
  return { text, redacted: r.count, truncated: cut };
}
export const outputMessage = (a, ex) => `🤖 output of ${a.agent} (workspace "${a.workspace}", ${a.status}), shared by hand and cleaned of obvious secrets:\n${ex.text}`;
