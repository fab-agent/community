// Community TUI: scrollable member list on top, command/message input at the bottom.
// Mouse: wheel scrolls, left click selects, right click opens a context menu.
import { loadConfig, saveConfig, api, readJson, writeJson, herdr, clean, oneLine, configDir } from "./lib.mjs";
import { loadOrCreateSigner, signMessage, verdict, fingerprint, dmTarget, topicTarget } from "./sign.mjs";

const cfg = loadConfig();
if (!cfg) { console.log("Run setup first: Community: open"); process.exit(1); }

const E = "\x1b[";
const S = { dim: E + "2m", b: E + "1m", g: E + "32m", y: E + "33m", c: E + "36m", inv: E + "7m", r: E + "0m" };
const out = (s) => process.stdout.write(s);
const hhmm = (t) => new Date(t).toTimeString().slice(0, 5);
const dayKey = (t) => new Date(t).toDateString();
const dayLabel = (t) => {
  const d = new Date(t), now = new Date(), yest = new Date(now - 864e5);
  if (d.toDateString() === now.toDateString()) return "Today";
  if (d.toDateString() === yest.toDateString()) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: d.getFullYear() === now.getFullYear() ? undefined : "numeric" });
};
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const fit = (s, w) => { // truncate by visible width, keep colour codes
  let n = 0, o = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\x1b") { const m = s.slice(i).match(/^\x1b\[[0-9;]*m/); if (m) { o += m[0]; i += m[0].length - 1; continue; } }
    if (n >= w) break;
    o += s[i]; n++;
  }
  return o + S.r;
};

let members = [], msgs = [], since = 0;
let section = "people";       // "people" | "topics" (Left/Right switches when the input is empty)
let topics = [], tmsgs = {}, tsince = {}, selTopic = null, tunread = {};
let view = "list";            // "list" | "chat" (chat = one person or one topic, by section)
const signer = loadOrCreateSigner(configDir());
const pins = readJson("pins.json", {});
let selName = null;           // highlighted member
let top = 0, ttop = 0, cscroll = 0;     // list offset / chat lines scrolled up from bottom
let input = "", status = "";
let menu = null;              // { x, y, items:[{label, run}] }
const unread = {};
const meRec = () => members.find((m) => m.name === cfg.me);
const isAdmin = () => meRec()?.role === "admin";

// ---------- rows ----------
function listRows() {
  const by = {};
  for (const m of members) (by[m.department || "—"] ||= []).push(m);
  const rows = [];
  for (const [d, ms] of Object.entries(by)) {
    rows.push({ head: d });
    for (const m of ms) rows.push({ m });
  }
  return rows;
}
function memberLine(m, selected, w) {
  const dot = m.online ? S.g + "●" + S.r : S.dim + "○" + S.r;
  const badge = unread[m.name] ? S.y + ` (${unread[m.name]})` + S.r : "";
  const line = ` ${dot} ${m.name}${m.role === "admin" ? " ★" : ""}${m.name === cfg.me ? " (you)" : ""}${badge}` +
    (m.title ? S.dim + " · " + m.title + S.r : "") + (m.task ? S.y + " — " + m.task + S.r : "");
  const f = fit(line, w);
  return selected ? S.inv + strip(f).padEnd(w).slice(0, w) + S.r : f;
}
const MARKS = { ok: S.g + "✓", unsigned: S.dim + "·", changed: E + "31m⚠ key changed", bad: E + "31m✗ forged", nosig: E + "31m!" };
function mark(m, target) {
  const mem = members.find((x) => x.id === m.from_id) || (pins[m.from_id] ? { id: m.from_id, pubkey: pins[m.from_id] } : undefined);
  const k = mem?.pubkey || "";
  if (m._v === undefined || m._k !== k) {
    m._k = k;
    m._v = verdict(pins, mem, m, target);
    if (m._v === "unsigned" && k) m._v = "nosig"; // keyed sender but no signature: suspicious
  }
  return MARKS[m._v] + S.r;
}
function chatLines(w, list, targetOf) {
  const lines = [];
  let lastDay = null;
  for (const m of list) {
    if (dayKey(m.created_at) !== lastDay) {
      lastDay = dayKey(m.created_at);
      const label = ` ${dayLabel(m.created_at)} `;
      lines.push(S.dim + "─".repeat(2) + label + "─".repeat(Math.max(0, w - label.length - 2)) + S.r);
    }
    const mine = m.from_name === cfg.me;
    const head = `${S.dim}${hhmm(m.created_at)}${S.r} ${mark(m, targetOf(m))} ${mine ? S.c + "you" : S.g + m.from_name}${S.r}: `;
    const pad = " ".repeat(strip(head).length);
    const body = m.body.split("\n");
    let first = true;
    for (const para of body) {
      const width = Math.max(10, w - strip(head).length);
      for (let i = 0; i < Math.max(1, para.length); i += width) {
        lines.push((first ? head : pad) + para.slice(i, i + width)); first = false;
      }
    }
  }
  return lines;
}

// ---------- drawing ----------
function draw() {
  const W = process.stdout.columns || 80, H = process.stdout.rows || 24;
  const h = Math.max(3, H - 4); // main area height
  let buf = E + "?25l" + E + "H";
  const line = (s) => (buf += E + "2K" + s + "\r\n");

  line(fit(`${S.b}▣ ${cfg.community}${S.r} ${S.dim}— ${cfg.me}${isAdmin() ? " ★ admin" : ""}${S.r}` +
    (view === "chat" ? `  ${S.c}${section === "topics" ? "# " + (topics.find((t) => t.id === selTopic)?.title ?? "") : selName}${S.r}${S.dim}  (Esc: back)${S.r}`
      : `  ${section === "people" ? S.inv + " People " + S.r : S.dim + " People " + S.r}${section === "topics" ? S.inv + " Discussions" + (Object.values(tunread).reduce((a, b) => a + b, 0) ? " (" + Object.values(tunread).reduce((a, b) => a + b, 0) + ")" : "") + " " + S.r : S.dim + " Discussions" + (Object.values(tunread).reduce((a, b) => a + b, 0) ? S.y + " (" + Object.values(tunread).reduce((a, b) => a + b, 0) + ")" + S.dim : "") + " " + S.r}${S.dim}  ←/→${S.r}`), W));

  const rows = [];
  if (view === "list" && section === "topics") {
    if (selTopic == null && topics.length) selTopic = topics[0].id;
    const i = Math.max(0, topics.findIndex((t) => t.id === selTopic));
    if (i < ttop) ttop = i; if (i >= ttop + h) ttop = i - h + 1;
    ttop = Math.max(0, Math.min(ttop, Math.max(0, topics.length - h)));
    if (!topics.length) rows.push(S.dim + " No discussions yet — start one with /topic <title>" + S.r);
    for (let j = 0; j < h && topics[ttop + j]; j++) {
      const t = topics[ttop + j], n = tunread[t.id] ? S.y + ` (${tunread[t.id]})` + S.r : "";
      const l = fit(` # ${t.title}${t.archived ? S.dim + " [archived]" : ""}${S.r}${n}${S.dim} · ${t.messages} msg · ${t.created_by ?? "?"}${S.r}`, W);
      rows.push(t.id === selTopic ? S.inv + strip(l).padEnd(W).slice(0, W) + S.r : l);
    }
  } else if (view === "list") {
    const all = listRows();
    const sIdx = all.findIndex((r) => r.m && r.m.name === selName);
    if (sIdx >= 0) { if (sIdx < top) top = sIdx; if (sIdx >= top + h) top = sIdx - h + 1; }
    top = Math.max(0, Math.min(top, Math.max(0, all.length - h)));
    for (let i = 0; i < h; i++) {
      const r = all[top + i];
      rows.push(!r ? "" : r.head ? `${S.b}${r.head}${S.r}` : memberLine(r.m, r.m.name === selName, W));
    }
  } else {
    const all = section === "topics"
      ? chatLines(W, tmsgs[selTopic] || [], () => topicTarget(selTopic))
      : chatLines(W, msgs.filter((x) => x.from_name === selName || x.to_name === selName), (m) => dmTarget(m.to_id));
    const maxUp = Math.max(0, all.length - h);
    cscroll = Math.max(0, Math.min(cscroll, maxUp));
    const end = all.length - cscroll, start = Math.max(0, end - h);
    const slice = all.slice(start, end);
    while (slice.length < h) slice.unshift("");
    rows.push(...slice);
  }
  for (const r of rows) line(fit(r, W));

  const hint = view === "list"
    ? "↑↓ select · Enter open · ←/→ people/discussions · Tab menu · /help"
    : "type to reply · wheel/PgUp scroll · Esc back · Tab menu";
  line(S.dim + "─".repeat(W) + S.r);
  line(fit(status ? S.y + status + S.r : S.dim + hint + S.r, W));
  const dest = section === "topics" ? (selTopic != null ? S.c + "#" + (topics.find((t) => t.id === selTopic)?.title ?? "") : S.dim + "no topic") : (selName ? S.c + selName : S.dim + "nobody");
  const prompt = `${S.dim}${cfg.me} →${S.r} ${dest}${S.r} › `;
  buf += E + "2K" + prompt + input;

  if (menu) {
    const wmax = Math.max(...menu.items.map((i) => i.label.length)) + 2;
    const x = Math.max(1, Math.min(menu.x, W - wmax)), y = Math.max(2, Math.min(menu.y, H - menu.items.length - 1));
    menu.box = { x, y, w: wmax };
    menu.items.forEach((it, i) => { buf += E + `${y + i};${x}H` + (i === menu.sel ? S.b + E + "7m" : E + "47;30m") + (" " + it.label).padEnd(wmax) + S.r; });
  }
  const col = strip(prompt).length + input.length + 1;
  buf += E + `${H};${Math.min(col, W)}H` + E + "?25h";
  out(buf);
}

// ---------- actions ----------
const flash = (s, ms = 4000) => { status = s; draw(); setTimeout(() => { if (status === s) { status = ""; draw(); } }, ms); };
const bell = () => out("\x07");

async function poll() {
  try {
    members = (await api(cfg, "GET", "/v1/members")).map((m) => ({ ...m, name: clean(m.name), title: clean(m.title), department: clean(m.department), task: clean(m.task) }));
    const sig = members.map((m) => m.id + m.name).join();
    if (lastSig !== null && sig !== lastSig) { msgs = []; since = 0; } // someone was renamed or removed: reload names
    lastSig = sig;
    const meNow = members.find((m) => m.id === cfg.id);
    if (meNow && meNow.name !== cfg.me) { cfg.me = meNow.name; saveConfig(cfg); }
    if (!selName && members.length) selName = (members.find((m) => m.name !== cfg.me) || members[0]).name;
    const fresh = await api(cfg, "GET", `/v1/messages?since=${since}`);
    for (const m of fresh) {
      since = Math.max(since, m.id);
      msgs.push({ ...m, from_name: clean(m.from_name), to_name: clean(m.to_name), body: clean(m.body) });
      if (m.from_name !== cfg.me) {
        if (!(view === "chat" && selName === m.from_name)) unread[m.from_name] = (unread[m.from_name] || 0) + 1;
        if (!firstPoll) {
          const mm = msgs[msgs.length - 1], ok = mark(mm, dmTarget(mm.to_id)).includes("✓");
          writeJson("last.json", { ...m, verified: ok }); bell();
        }
      }
    }
    try { await pollTopics(); } catch (e) { if (!/not found|HTTP 404/.test(e.message)) throw e; }
    if (!registered && meNow && !meNow.pubkey) {
      registered = true;
      try { await api(cfg, "POST", "/v1/me/key", { pubkey: signer.pubkey }); } catch (e) { status = "signing key: " + e.message; }
    } else if (meNow?.pubkey && meNow.pubkey !== signer.pubkey && !warnedKey) {
      warnedKey = true; status = "⚠ this device's signing key differs from the registered one — ask an admin to reset it (messages will be rejected)";
    }
    const pj = JSON.stringify(pins); if (pj !== pinsSaved) { writeJson("pins.json", pins); pinsSaved = pj; }
    if (view === "chat" && section === "topics") tunread[selTopic] = 0;
    firstPoll = false;
    if (status.startsWith("connection")) status = "";
  } catch (e) { status = "connection: " + e.message; }
  draw();
}
let firstPoll = true, lastSig = null, registered = false, warnedKey = false, pinsSaved = JSON.stringify(pins);
async function pollTopics() {
  topics = await api(cfg, "GET", "/v1/topics");
  for (const t of topics) {
    if (t.last_id <= (tsince[t.id] ?? 0)) continue;
    const fresh = await api(cfg, "GET", `/v1/topics/${t.id}/messages?since=${tsince[t.id] ?? 0}`);
    const list = (tmsgs[t.id] ||= []);
    for (const m of fresh) {
      tsince[t.id] = Math.max(tsince[t.id] ?? 0, m.id);
      list.push({ ...m, from_name: clean(m.from_name), body: clean(m.body) });
      if (m.from_name !== cfg.me && !firstPoll && !(view === "chat" && section === "topics" && selTopic === t.id)) { tunread[t.id] = (tunread[t.id] || 0) + 1; bell(); }
    }
  }
}

function openChat(name) { section = "people"; selName = name; view = "chat"; cscroll = 0; unread[name] = 0; draw(); }
function openTopic(id) { section = "topics"; selTopic = id; view = "chat"; cscroll = 0; tunread[id] = 0; draw(); }
function moveTopic(d) {
  if (!topics.length) return;
  const i = Math.max(0, Math.min(topics.length - 1, topics.findIndex((t) => t.id === selTopic) + d));
  selTopic = topics[i].id;
}
function move(d) {
  const ms = listRows().filter((r) => r.m).map((r) => r.m.name);
  if (!ms.length) return;
  const i = Math.max(0, Math.min(ms.length - 1, ms.indexOf(selName) + d));
  selName = ms[i];
}
function openMenu(x, y, target) {
  const items = [];
  if (target) {
    items.push({ label: `Message ${target.name}`, run: () => openChat(target.name) });
    if (isAdmin() || target.name === cfg.me)
      items.push({ label: `Rename ${target.name}…`, run: () => { input = target.name === cfg.me ? "/rename " : `/rename ${target.name} | `; draw(); } });
    if (isAdmin() && target.name !== cfg.me)
      items.push({ label: `Remove ${target.name}…`, run: () => confirmRemove(target.name) });
  }
  if (isAdmin()) items.push({ label: "Invite someone…", run: () => { input = "/invite Name | Department | Title"; draw(); } });
  if (section === "topics" && selTopic != null && isAdmin()) {
    const t = topics.find((x) => x.id === selTopic);
    items.push({ label: t?.archived ? "Unarchive discussion" : "Archive discussion", run: () => command(t?.archived ? "/archive undo" : "/archive") });
  }
  items.push({ label: "New discussion…", run: () => { input = "/topic "; draw(); } });
  if (target && target.pubkey) items.push({ label: `Safety number: ${target.name}`, run: () => command(`/fp ${target.name}`) });
  items.push({ label: "Pull last message to a pane…", run: paneMenu });
  items.push({ label: "Refresh", run: () => poll() });
  menu = { x, y, items, sel: Math.min(1, items.length - 1) < 0 ? 0 : 0 };
  draw();
}
function paneMenu() {
  const W = process.stdout.columns || 80, H = process.stdout.rows || 24;
  const last = readJson("last.json", null);
  if (!last) return flash("no messages yet");
  let panes = [], wsName = {};
  try {
    panes = herdr(["pane", "list"]).result.panes;
    for (const w of herdr(["workspace", "list"]).result.workspaces) wsName[w.workspace_id] = w.label;
  } catch (e) { return flash("cannot list panes: " + e.message); }
  panes = panes.filter((p) => p.label !== "Community" && !String(wsName[p.workspace_id]).startsWith("▣"));
  if (!panes.length) return flash("no other panes");
  const room = Math.max(3, H - 6);
  const items = panes.slice(0, room).map((p) => ({
    label: oneLine(`${wsName[p.workspace_id] ?? p.workspace_id} · ${p.agent ? p.agent + " · " : ""}${p.terminal_title_stripped || p.cwd} (${p.pane_id})`).slice(0, Math.max(20, W - 8)),
    run: () => command(`/pull ${p.pane_id}`),
  }));
  items.push({ label: "Cancel", run: () => {} });
  menu = { x: 3, y: 3, items, sel: 0 };
  flash(`Paste ${oneLine(last.from_name)}'s last message into which pane?`, 8000);
  draw();
}
function confirmRemove(name) {
  menu = { x: 4, y: 4, items: [
    { label: `Really remove ${name}?`, run: () => {} },
    { label: "Yes, remove", run: async () => { await command(`/remove ${name}`); } },
    { label: "Cancel", run: () => {} },
  ], sel: 2 };
  draw();
}

const help = "/who /to <name> [msg] /task <text> /rename <new> /title <t> /dept <d> (admins: <name> | <value>) /invite <name> | <dept> | <title> [| admin] /remove <name> /topics /people /topic <title> /archive[ undo] /fp [name] /pull [pane] /quit";
async function command(t) {
  try {
    if (t === "/help") flash(help, 10000);
    else if (t === "/quit") quit();
    else if (t === "/who") { view = "list"; draw(); }
    else if (t.startsWith("/task ")) { await api(cfg, "PATCH", "/v1/me", { task: t.slice(6) }); await poll(); flash("task updated"); }
    else if (/^\/(rename|title|dept)\b/.test(t)) {
      const field = { rename: "name", title: "title", dept: "department" }[t.slice(1).split(/\s/)[0]];
      const rest = t.replace(/^\/\w+\s*/, "");
      let target = null, value = rest;
      if (rest.includes("|")) { const [who, ...v] = rest.split("|"); target = who.trim(); value = v.join("|").trim(); }
      if (!value && field === "name") return flash("usage: /rename <new name>  (admins: /rename <old> | <new>)");
      if (target && target !== cfg.me) {
        await api(cfg, "POST", `/v1/admin/members/${encodeURIComponent(target)}/profile`, { [field]: value });
        if (selName === target && field === "name") selName = value;
      } else {
        await api(cfg, "PATCH", "/v1/me", { [field]: value });
        if (field === "name") { if (selName === cfg.me) selName = value; cfg.me = value; saveConfig(cfg); }
      }
      msgs = []; since = 0; await poll(); flash("updated");
    }
    else if (t.startsWith("/to ")) {
      const rest = t.slice(4).trim();
      const m = [...members].sort((a, b) => b.name.length - a.name.length).find((x) => rest.toLowerCase().startsWith(x.name.toLowerCase()));
      if (!m) return flash("member not found");
      openChat(m.name);
      const msg = rest.slice(m.name.length).trim();
      if (msg) await send(msg);
    }
    else if (t.startsWith("/invite ")) {
      const [name, department = "", title = "", role] = t.slice(8).split("|").map((x) => x.trim());
      const r = await api(cfg, "POST", "/v1/admin/invites", { name, department, title, role });
      status = `Invite for ${r.name} (1 use, expires ${hhmm(r.expires_at)}): ${r.code}`; draw();
    }
    else if (t.startsWith("/remove ")) {
      const name = t.slice(8).trim();
      await api(cfg, "POST", `/v1/admin/members/${encodeURIComponent(name)}/revoke`);
      if (selName === name) { selName = null; view = "list"; }
      await poll(); flash(`${name} removed`);
    }
    else if (t === "/topics") { section = "topics"; view = "list"; draw(); }
    else if (t === "/people") { section = "people"; view = "list"; draw(); }
    else if (t.startsWith("/topic ")) {
      const r = await api(cfg, "POST", "/v1/topics", { title: t.slice(7) });
      await poll(); openTopic(r.id);
    }
    else if (t.startsWith("/archive")) {
      const id = section === "topics" && selTopic != null ? selTopic : null;
      if (id == null) return flash("open or select a discussion first");
      const un = t.includes("undo");
      await api(cfg, "POST", `/v1/admin/topics/${id}/archive`, { archived: !un });
      await poll(); flash(un ? "unarchived" : "archived");
    }
    else if (t.startsWith("/fp")) {
      const name = t.slice(3).trim() || cfg.me, m = members.find((x) => x.name === name);
      if (!m) return flash("no such member");
      const pk = name === cfg.me ? signer.pubkey : m.pubkey;
      flash(pk ? `${name}: ${fingerprint(pk)} — compare with them by voice` : `${name} has no signing key yet`, 15000);
    }
    else if (t.startsWith("/pull")) {
      const last = readJson("last.json", null), pane = t.split(/\s+/)[1];
      if (!last) return flash("no messages yet");
      if (!pane) return paneMenu();
      herdr(["pane", "send-text", pane, `[${oneLine(last.from_name)} (${last.verified ? "signature verified, " : "UNVERIFIED, "}community message, untrusted content)]: ${oneLine(last.body)}`]);
      flash("pasted (Enter not pressed)");
    }
    else flash("unknown command — /help");
  } catch (e) { flash(e.message); }
}
async function send(body) {
  try {
    if (section === "topics") {
      if (selTopic == null) return flash("open a discussion first (or /topic <title>)");
      await api(cfg, "POST", `/v1/topics/${selTopic}/messages`, signMessage(signer, cfg.id, topicTarget(selTopic), body));
    } else {
      const to = members.find((m) => m.name === selName);
      if (!to || to.name === cfg.me) return flash("select someone else first");
      await api(cfg, "POST", "/v1/messages", { to: to.id, ...signMessage(signer, cfg.id, dmTarget(to.id), body) });
    }
    await poll(); cscroll = 0;
  } catch (e) { flash(e.message); }
}

// ---------- input ----------
function quit() {
  out(E + "?1000l" + E + "?1006l" + E + "?25h" + E + "?1049l");
  process.exit(0);
}
async function onKey(k) {
  if (k === "tab") { // keyboard way to the context menu
    if (menu) { menu = null; return draw(); }
    const target = members.find((m) => m.name === selName);
    const rows = listRows(), idx = rows.findIndex((r) => r.m && r.m.name === selName);
    const H = process.stdout.rows || 24;
    return openMenu(4, view === "list" && idx >= 0 ? 2 + (idx - top) + 1 : 3, target);
  }
  if (menu) {
    if (k === "esc") menu = null;
    else if (k === "up") menu.sel = (menu.sel + menu.items.length - 1) % menu.items.length;
    else if (k === "down") menu.sel = (menu.sel + 1) % menu.items.length;
    else if (k === "enter") { const it = menu.items[menu.sel]; menu = null; draw(); await it.run(); return; }
    return draw();
  }
  if ((k === "left" || k === "right") && view === "list" && !input) { section = section === "people" ? "topics" : "people"; }
  else if (k === "up") { if (view === "list") (section === "topics" ? moveTopic(-1) : move(-1)); else cscroll++; }
  else if (k === "down") { if (view === "list") (section === "topics" ? moveTopic(1) : move(1)); else cscroll = Math.max(0, cscroll - 1); }
  else if (k === "pgup") { if (view === "list") top -= 5; else cscroll += 5; }
  else if (k === "pgdn") { if (view === "list") top += 5; else cscroll -= 5; }
  else if (k === "esc") { if (input) input = ""; else view = "list"; }
  else if (k === "enter") {
    const t = input.trim(); input = "";
    if (!t) { if (view === "list") { if (section === "topics") { if (selTopic != null) openTopic(selTopic); } else if (selName) openChat(selName); } }
    else if (t.startsWith("/")) await command(t);
    else await send(t);
  }
  else if (k === "bs") input = input.slice(0, -1);
  else if (k === "quit") quit();
  else if (k.length === 1 || k.startsWith("txt:")) input += k.startsWith("txt:") ? k.slice(4) : k;
  draw();
}
async function onMouse(b, x, y, press) {
  if (!press) return;
  const H = process.stdout.rows || 24, h = Math.max(3, H - 4);
  if (menu) {
    const bx = menu.box;
    if (bx && x >= bx.x && x < bx.x + bx.w && y >= bx.y && y < bx.y + menu.items.length) {
      const it = menu.items[y - bx.y]; menu = null; draw(); await it.run(); return;
    }
    menu = null; draw(); if (b !== 0 && b !== 2) return;
  }
  if (b === 64) { if (view === "list") top -= 3; else cscroll += 3; return draw(); }
  if (b === 65) { if (view === "list") top += 3; else cscroll = Math.max(0, cscroll - 3); return draw(); }
  const inMain = y >= 2 && y < 2 + h;
  if (section === "topics" && view === "list" && inMain) {
    const t = topics[ttop + (y - 2)];
    if (t && (b === 0 || b === 2)) {
      const dbl = selTopic === t.id && Date.now() - lastClick < 400; selTopic = t.id; lastClick = Date.now();
      if (b === 0 && dbl) return openTopic(t.id);
      if (b === 2) return openMenu(x, y, null);
      return draw();
    }
    return;
  }
  const row = view === "list" && inMain ? listRows()[top + (y - 2)] : null;
  if (b === 0 && row?.m) { if (selName === row.m.name && Date.now() - lastClick < 400) openChat(row.m.name); selName = row.m.name; lastClick = Date.now(); draw(); }
  else if (b === 2 && inMain) { if (row?.m) selName = row.m.name; openMenu(x, y, row?.m || (view === "chat" ? members.find((m) => m.name === selName) : null)); }
}
let lastClick = 0;

process.stdin.setRawMode(true);
process.stdin.setEncoding("utf8");
process.stdin.on("data", async (d) => {
  const re = /\x1b\[<(\d+);(\d+);(\d+)([Mm])|\x1b\[A|\x1b\[B|\x1b\[5~|\x1b\[6~|\x1b\[[0-9;?]*[A-Za-z~]|\x1b|\t|\r|\n|\x7f|\x03|\x04|[^\x00-\x1f\x7f\x1b]+/g;
  let m;
  while ((m = re.exec(d))) {
    const s = m[0];
    if (m[1] !== undefined) await onMouse(+m[1], +m[2], +m[3], m[4] === "M");
    else if (s === "\x1b[A") await onKey("up");
    else if (s === "\x1b[B") await onKey("down");
    else if (s === "\x1b[C") await onKey("right");
    else if (s === "\x1b[D") await onKey("left");
    else if (s === "\x1b[5~") await onKey("pgup");
    else if (s === "\x1b[6~") await onKey("pgdn");
    else if (s === "\x1b") await onKey("esc");
    else if (s === "\t") await onKey("tab");
    else if (s === "\r" || s === "\n") await onKey("enter");
    else if (s === "\x7f") await onKey("bs");
    else if (s === "\x03" || s === "\x04") await onKey("quit");
    else if (s.startsWith("\x1b")) continue;
    else await onKey("txt:" + s);
  }
});
process.stdout.on("resize", draw);
process.on("exit", () => out(E + "?1000l" + E + "?1006l"));

if (!cfg.id) { try { const me = await api(cfg, "GET", "/v1/me"); cfg.id = me.id; cfg.me = me.name; saveConfig(cfg); } catch {} }
out(E + "?1049h" + E + "?1000h" + E + "?1006h");
await poll();
setInterval(poll, 3000);
