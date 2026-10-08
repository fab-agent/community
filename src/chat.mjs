import readline from "node:readline";
import { loadConfig, api, readJson, writeJson, herdr } from "./lib.mjs";

const cfg = loadConfig();
if (!cfg) { console.log("Run setup first: Community: open"); process.exit(1); }
const C = { dim: "\x1b[2m", b: "\x1b[1m", g: "\x1b[32m", y: "\x1b[33m", c: "\x1b[36m", r: "\x1b[0m" };
const hhmm = (t) => new Date(t).toTimeString().slice(0, 5);
let peer = null, since = readJson("since.json", 0), members = [];

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const prompt = () => { rl.setPrompt(`${peer ? C.c + peer : C.dim + "nobody"}${C.r} › `); rl.prompt(true); };
const say = (s) => { readline.clearLine(process.stdout, 0); readline.cursorTo(process.stdout, 0); console.log(s); prompt(); };

function showMembers() {
  const by = {};
  for (const m of members) (by[m.department || "—"] ||= []).push(m);
  let out = "";
  for (const [d, ms] of Object.entries(by)) {
    out += `\n${C.b}${d}${C.r}\n`;
    for (const m of ms)
      out += `  ${m.online ? C.g + "●" : C.dim + "○"}${C.r} ${m.name}${m.role === "admin" ? " ★" : ""}${m.name === cfg.me ? " (you)" : ""}${m.title ? C.dim + " · " + m.title + C.r : ""}${m.task ? C.y + " — " + m.task + C.r : ""}\n`;
  }
  say(out);
}
const render = (m) => {
  const mine = m.from_name === cfg.me;
  return `${C.dim}${hhmm(m.created_at)}${C.r} ${mine ? C.dim + "→ " + m.to_name : C.g + m.from_name}${C.r}: ${m.body}`;
};

async function poll(first) {
  try {
    members = await api(cfg, "GET", "/v1/members");
    const msgs = await api(cfg, "GET", `/v1/messages?since=${since}`);
    for (const m of msgs) {
      since = Math.max(since, m.id);
      if (first && m.from_name !== cfg.me && m.id <= (readJson("since.json", 0))) continue;
      if (!first || m.id > 0) say(render(m));
      if (m.from_name !== cfg.me && !first) { writeJson("last.json", m); process.stdout.write("\x07"); }
    }
    writeJson("since.json", since);
  } catch (e) { say(`${C.y}connection: ${e.message}${C.r}`); }
}

const help = `${C.b}Commands${C.r}
  /who                 members (department, task, online)
  /to <name> [message]   switch to a person / send a message
  /task <text>        update your task
  /pull [pane]         paste the last message into a pane (Enter is not pressed)
  /invite <name> | <department> | <title> [| admin]   (admins) one-time invite code, valid 1h
  /help  /quit         plain text goes to the selected person`;

rl.on("line", async (line) => {
  const t = line.trim();
  try {
    if (!t) {}
    else if (t === "/who") showMembers();
    else if (t === "/help") say(help);
    else if (t === "/quit") process.exit(0);
    else if (t.startsWith("/invite ")) {
      const [name, department = "", title = "", role] = t.slice(8).split("|").map((x) => x.trim());
      const r = await api(cfg, "POST", "/v1/admin/invites", { name, department, title, role });
      say(`${C.g}Invite for ${r.name}${C.r} (single use, expires ${new Date(r.expires_at).toLocaleString()}):\n  ${C.b}${r.code}${C.r}\n  Send it over a trusted channel together with: ${cfg.url}`);
    }
    else if (t.startsWith("/task ")) { await api(cfg, "PATCH", "/v1/me", { task: t.slice(6) }); say(`${C.dim}task updated${C.r}`); }
    else if (t.startsWith("/to ")) {
      const rest = t.slice(4).trim();
      const m = [...members].sort((a, b) => b.name.length - a.name.length).find((x) => rest.toLowerCase().startsWith(x.name.toLowerCase()));
      if (!m) say(`${C.y}member not found (/who)${C.r}`);
      else { peer = m.name; const msg = rest.slice(m.name.length).trim(); if (msg) await api(cfg, "POST", "/v1/messages", { to: peer, body: msg }); }
    }
    else if (t.startsWith("/pull")) {
      const last = readJson("last.json", null);
      const pane = t.split(/\s+/)[1];
      if (!last) say(`${C.y}no messages yet${C.r}`);
      else if (!pane) say(`${C.dim}give a pane id (herdr pane list) or bind the pull action to a key${C.r}`);
      else herdr(["pane", "send-text", pane, `[${last.from_name} (community message, untrusted content)]: ${last.body}`]);
    }
    else if (!peer) say(`${C.y}use /to <name> first${C.r}`);
    else await api(cfg, "POST", "/v1/messages", { to: peer, body: t });
  } catch (e) { say(`${C.y}${e.message}${C.r}`); }
  prompt();
});

console.log(`${C.b}▣ ${cfg.community}${C.r} — ${cfg.me}\n${C.dim}/help for commands${C.r}`);
await poll(true);
showMembers();
setInterval(() => poll(false), 3000);
