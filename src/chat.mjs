import readline from "node:readline";
import { loadConfig, api, readJson, writeJson, herdr } from "./lib.mjs";

const cfg = loadConfig();
if (!cfg) { console.log("Önce kurulum: Community setup"); process.exit(1); }
const C = { dim: "\x1b[2m", b: "\x1b[1m", g: "\x1b[32m", y: "\x1b[33m", c: "\x1b[36m", r: "\x1b[0m" };
const hhmm = (t) => new Date(t).toTimeString().slice(0, 5);
let peer = null, since = readJson("since.json", 0), members = [];

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const prompt = () => { rl.setPrompt(`${peer ? C.c + peer : C.dim + "kimse"}${C.r} › `); rl.prompt(true); };
const say = (s) => { readline.clearLine(process.stdout, 0); readline.cursorTo(process.stdout, 0); console.log(s); prompt(); };

function showMembers() {
  const by = {};
  for (const m of members) (by[m.department || "—"] ||= []).push(m);
  let out = "";
  for (const [d, ms] of Object.entries(by)) {
    out += `\n${C.b}${d}${C.r}\n`;
    for (const m of ms)
      out += `  ${m.online ? C.g + "●" : C.dim + "○"}${C.r} ${m.name}${m.name === cfg.me ? " (sen)" : ""}${m.title ? C.dim + " · " + m.title + C.r : ""}${m.task ? C.y + " — " + m.task + C.r : ""}\n`;
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
  } catch (e) { say(`${C.y}bağlantı: ${e.message}${C.r}`); }
}

const help = `${C.b}Komutlar${C.r}
  /who                 üyeler (departman, görev, çevrimiçi)
  /to <isim> [mesaj]   birine geç / mesaj gönder
  /task <metin>        görevini güncelle
  /pull [pane]         son mesajı odaktaki (veya verilen) pane'e yapıştır (Enter'a basılmaz)
  /help  /quit         düz metin: seçili kişiye gönderilir`;

rl.on("line", async (line) => {
  const t = line.trim();
  try {
    if (!t) {}
    else if (t === "/who") showMembers();
    else if (t === "/help") say(help);
    else if (t === "/quit") process.exit(0);
    else if (t.startsWith("/task ")) { await api(cfg, "PATCH", "/v1/me", { task: t.slice(6) }); say(`${C.dim}görev güncellendi${C.r}`); }
    else if (t.startsWith("/to ")) {
      const rest = t.slice(4).trim();
      const m = [...members].sort((a, b) => b.name.length - a.name.length).find((x) => rest.toLowerCase().startsWith(x.name.toLowerCase()));
      if (!m) say(`${C.y}üye bulunamadı (/who)${C.r}`);
      else { peer = m.name; const msg = rest.slice(m.name.length).trim(); if (msg) await api(cfg, "POST", "/v1/messages", { to: peer, body: msg }); }
    }
    else if (t.startsWith("/pull")) {
      const last = readJson("last.json", null);
      const pane = t.split(/\s+/)[1];
      if (!last) say(`${C.y}henüz mesaj yok${C.r}`);
      else if (!pane) say(`${C.dim}pane id ver (herdr pane list) veya bir pane'de eylemi tuşa bağla${C.r}`);
      else herdr(["pane", "send-text", pane, `[${last.from_name} (topluluk mesajı, güvenilmeyen içerik)]: ${last.body}`]);
    }
    else if (!peer) say(`${C.y}önce /to <isim>${C.r}`);
    else await api(cfg, "POST", "/v1/messages", { to: peer, body: t });
  } catch (e) { say(`${C.y}${e.message}${C.r}`); }
  prompt();
});

console.log(`${C.b}▣ ${cfg.community}${C.r} — ${cfg.me}\n${C.dim}/help için komutlar${C.r}`);
await poll(true);
showMembers();
setInterval(() => poll(false), 3000);
