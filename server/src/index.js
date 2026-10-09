// fab-community: tiny community server (members + direct messages) for the Herdr plugin.
// Auth: per-member key (Bearer). Admin: ADMIN_KEY secret. Keys are stored as SHA-256 hashes.
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const err = (status, message) => json({ error: message }, status);

const sha256 = async (s) => {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
};
const randomCode = () => {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return "fci_" + [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
};
const randomKey = () => {
  const b = crypto.getRandomValues(new Uint8Array(24));
  return "fck_" + [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
};
const safeEq = (a, b) => {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
};
const bearer = (req) => (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
const pub = (m) => ({
  id: m.id, role: m.role || "member", name: m.name, department: m.department, title: m.title, task: m.task,
  pubkey: m.pubkey || null,
  last_seen: m.last_seen, online: Date.now() - m.last_seen < 90_000,
});
// Strip control characters (incl. ESC, so no terminal escape sequences reach other members' screens).
const clip = (v, n) => String(v ?? "").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "").slice(0, n);
const clipLine = (v, n) => clip(v, n).replace(/[\n\t]+/g, " ");

// ---- signed messages -------------------------------------------------------
// Every message can carry an Ed25519 signature made on the sender's device over
//   community/v1 \n from_id \n target \n ts \n nonce \n body      (target = "dm:<id>" | "topic:<id>")
// The server checks it before storing; receiving clients check it again against the sender's pinned key,
// so neither the server nor another member can put words in someone's mouth undetected.
const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const canonical = (from, target, ts, nonce, body) => `community/v1\n${from}\n${target}\n${ts}\n${nonce}\n${body}`;
async function verifySig(pubkey, msg, sig) {
  try {
    const k = await crypto.subtle.importKey("raw", b64(pubkey), { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, k, b64(sig), new TextEncoder().encode(msg));
  } catch { return false; }
}
const validPubkey = (k) => typeof k === "string" && /^[A-Za-z0-9+/]{43}=$/.test(k);
// Validate/store a message from `me`. target = {kind:"dm",to_id} | {kind:"topic",topic_id}.
async function storeMessage(env, me, b, target, now) {
  const body = clip(b.body, 4000).trim();
  if (!body) return err(400, "body required");
  const tgt = target.kind === "dm" ? `dm:${target.to_id}` : `topic:${target.topic_id}`;
  let ts = null, nonce = null, sig = null;
  if (me.pubkey) {
    // A member who registered a key must sign everything (no unsigned downgrade).
    ts = Number(b.ts); nonce = String(b.nonce || ""); sig = String(b.sig || "");
    if (!sig || !/^[A-Za-z0-9_-]{8,64}$/.test(nonce) || !Number.isFinite(ts)) return err(400, "signature required (ts, nonce, sig)");
    if (Math.abs(now - ts) > 600_000) return err(400, "timestamp out of range");
    if (b.body !== body) return err(400, "body must be sent trimmed and without control characters");
    if (!(await verifySig(me.pubkey, canonical(me.id, tgt, ts, nonce, body), sig))) return err(400, "bad signature");
  }
  try {
    const r = await env.DB.prepare("INSERT INTO messages (from_id,to_id,body,created_at,topic_id,ts,nonce,sig) VALUES (?,?,?,?,?,?,?,?)")
      .bind(me.id, target.kind === "dm" ? target.to_id : "", body, now, target.kind === "topic" ? target.topic_id : null, ts, nonce, sig || null).run();
    return json({ id: r.meta.last_row_id }, 201);
  } catch { return err(409, "replayed message"); }
}

// Retention is set per deployment: MESSAGE_RETENTION_DAYS (0 or unset = keep forever).
const DAY = 86_400_000;
const retentionDays = (env) => Math.max(0, Number(env.MESSAGE_RETENTION_DAYS) || 0);
const cutoff = (env, now) => (retentionDays(env) ? now - retentionDays(env) * DAY : 0);
const purge = async (env, now = Date.now()) => {
  const c = cutoff(env, now);
  if (!c) return 0;
  const r = await env.DB.prepare("DELETE FROM messages WHERE created_at < ?").bind(c).run();
  return r.meta.changes ?? 0;
};

// Apply a profile edit (name/title/department) to a member row. Returns an error Response or null.
async function editProfile(env, member, b) {
  const f = {};
  if (b.title !== undefined) f.title = clipLine(b.title, 60);
  if (b.department !== undefined) f.department = clipLine(b.department, 60);
  if (b.task !== undefined) f.task = clipLine(b.task, 200);
  if (b.name !== undefined) {
    const name = clipLine(b.name, 40).trim();
    if (!name) return err(400, "name required");
    if (name !== member.name) {
      if (await env.DB.prepare("SELECT 1 FROM members WHERE name=? AND revoked=0 AND id!=?").bind(name, member.id).first())
        return err(409, "name already exists");
      // a removed member keeps history under a tagged name and frees this one
      await env.DB.prepare("UPDATE members SET name=name||' ['||substr(id,1,6)||']' WHERE name=? AND revoked=1").bind(name).run();
      f.name = name;
    }
  }
  const keys = Object.keys(f);
  if (!keys.length) return null;
  await env.DB.prepare(`UPDATE members SET ${keys.map((k) => k + "=?").join(",")} WHERE id=?`).bind(...keys.map((k) => f[k]), member.id).run();
  Object.assign(member, f);
  return null;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname;
    const now = Date.now();

    if (path === "/" || path === "/v1/community")
      return json({
        name: env.COMMUNITY_NAME || "community", api: "v1",
        message_retention_days: retentionDays(env) || null,
      });

    // ---- join: redeem a single-use invite (no auth; the code is the credential) ----
    if (path === "/v1/join" && req.method === "POST") {
      const b = await req.json().catch(() => ({}));
      const code = clipLine(b.code, 64).trim();
      if (!code) return err(400, "code required");
      const ch = await sha256(code);
      // Atomically consume the invite; a second redeem (or an expired code) matches nothing.
      const used = await env.DB.prepare(
        "UPDATE invites SET used_at=? WHERE code_hash=? AND used_at IS NULL AND expires_at>?"
      ).bind(now, ch, now).run();
      if (!used.meta.changes) return err(410, "invite is invalid, used or expired");
      const inv = await env.DB.prepare("SELECT * FROM invites WHERE code_hash=?").bind(ch).first();
      const key = randomKey();
      const id = crypto.randomUUID();
      const pubkey = validPubkey(b.pubkey) ? b.pubkey : null;
      // A removed member keeps their message history but frees the name for re-invites.
      await env.DB.prepare("UPDATE members SET name=name||' ['||substr(id,1,6)||']' WHERE name=? AND revoked=1").bind(inv.name).run();
      try {
        await env.DB.prepare(
          "INSERT INTO members (id,name,department,title,role,key_hash,pubkey,created_at) VALUES (?,?,?,?,?,?,?,?)"
        ).bind(id, inv.name, inv.department, inv.title, inv.role, await sha256(key), pubkey, now).run();
      } catch {
        await env.DB.prepare("UPDATE invites SET used_at=NULL WHERE code_hash=?").bind(ch).run();
        return err(409, "name already exists");
      }
      return json({ id, name: inv.name, role: inv.role, key }, 201);
    }

    // ---- admin: ADMIN_KEY (bootstrap) or a member whose role is "admin" ----
    if (path.startsWith("/v1/admin/")) {
      const k = bearer(req);
      let actor = null; // null = root
      if (!(env.ADMIN_KEY && k && safeEq(k, env.ADMIN_KEY))) {
        actor = k && await env.DB.prepare("SELECT * FROM members WHERE key_hash=? AND revoked=0 AND role='admin'").bind(await sha256(k)).first();
        if (!actor) return err(401, "admin required");
      }
      const by = actor ? actor.id : "root";

      if (path === "/v1/admin/invites" && req.method === "POST") {
        const b = await req.json().catch(() => ({}));
        const name = clipLine(b.name, 40).trim();
        if (!name) return err(400, "name required");
        if (await env.DB.prepare("SELECT 1 FROM members WHERE name=? AND revoked=0").bind(name).first()) return err(409, "name already exists");
        const hours = Math.min(Math.max(Number(b.ttl_hours) || 1, 1), 24 * 14);
        const role = b.role === "admin" ? "admin" : "member";
        if (role === "admin" && actor) return err(403, "only the root ADMIN_KEY can invite admins");
        // At most one invite per minute per admin: limits invite spam and brute-force name probing.
        const last = await env.DB.prepare("SELECT MAX(created_at) AS t FROM invites WHERE created_by=?").bind(by).first();
        if (last?.t && now - last.t < 60_000)
          return json({ error: "wait before creating another invite", retry_after: Math.ceil((60_000 - (now - last.t)) / 1000) }, 429);
        const code = randomCode();
        const expires_at = now + hours * 3_600_000;
        await env.DB.prepare(
          "INSERT INTO invites (code_hash,name,department,title,role,created_by,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?)"
        ).bind(await sha256(code), name, clipLine(b.department, 60), clipLine(b.title, 60), role, by, now, expires_at).run();
        return json({ code, name, role, expires_at }, 201);
      }
      if (path === "/v1/admin/invites" && req.method === "GET") {
        const { results } = await env.DB.prepare(
          "SELECT name,department,title,role,created_at,expires_at,used_at FROM invites ORDER BY created_at DESC LIMIT 100"
        ).all();
        return json(results);
      }
      const inv = path.match(/^\/v1\/admin\/invites\/([^/]+)\/cancel$/);
      if (inv && req.method === "POST") {
        const r = await env.DB.prepare("DELETE FROM invites WHERE name=? AND used_at IS NULL").bind(decodeURIComponent(inv[1])).run();
        return json({ cancelled: r.meta.changes });
      }
      if (path === "/v1/admin/members" && req.method === "POST") {
        if (actor) return err(403, "direct member creation needs the root ADMIN_KEY; use invites");
        const b = await req.json().catch(() => ({}));
        const name = clipLine(b.name, 40).trim();
        if (!name) return err(400, "name required");
        const key = randomKey();
        const id = crypto.randomUUID();
        await env.DB.prepare("UPDATE members SET name=name||' ['||substr(id,1,6)||']' WHERE name=? AND revoked=1").bind(name).run();
        try {
          await env.DB.prepare(
            "INSERT INTO members (id,name,department,title,task,role,key_hash,created_at) VALUES (?,?,?,?,?,?,?,?)"
          ).bind(id, name, clipLine(b.department, 60), clipLine(b.title, 60), clipLine(b.task, 200), b.role === "admin" ? "admin" : "member", await sha256(key), now).run();
        } catch (e) { return err(409, "name already exists"); }
        return json({ id, name, key }, 201);
      }
      if (path === "/v1/admin/members" && req.method === "GET") {
        const { results } = await env.DB.prepare("SELECT * FROM members ORDER BY name").all();
        return json(results.map((m) => ({ ...pub(m), revoked: !!m.revoked })));
      }
      const role = path.match(/^\/v1\/admin\/members\/([^/]+)\/role$/);
      if (role && req.method === "POST") {
        if (actor) return err(403, "only the root ADMIN_KEY can change roles");
        const b = await req.json().catch(() => ({}));
        const r = b.role === "admin" ? "admin" : "member";
        const x = await env.DB.prepare("UPDATE members SET role=? WHERE id=? OR name=?").bind(r, role[1], decodeURIComponent(role[1])).run();
        return json({ updated: x.meta.changes, role: r });
      }
      const prof = path.match(/^\/v1\/admin\/members\/([^/]+)\/profile$/);
      if (prof && req.method === "POST") {
        const target = await env.DB.prepare("SELECT * FROM members WHERE (id=? OR name=?) AND revoked=0").bind(prof[1], decodeURIComponent(prof[1])).first();
        if (!target) return err(404, "not found");
        const b = await req.json().catch(() => ({}));
        const e = await editProfile(env, target, b);
        return e || json(pub(target));
      }
      const rev = path.match(/^\/v1\/admin\/members\/([^/]+)\/revoke$/);
      if (rev && req.method === "POST") {
        const target = await env.DB.prepare("SELECT * FROM members WHERE id=? OR name=?").bind(rev[1], decodeURIComponent(rev[1])).first();
        if (!target) return err(404, "not found");
        if (actor && (target.role === "admin" || target.id === actor.id)) return err(403, "admins can only be revoked with the root ADMIN_KEY");
        await env.DB.prepare("UPDATE members SET revoked=1 WHERE id=?").bind(target.id).run();
        return json({ ok: true });
      }
      const rk = path.match(/^\/v1\/admin\/members\/([^/]+)\/reset-key$/);
      if (rk && req.method === "POST") { // lost device: forget the signing key so the member can register a new one
        const x = await env.DB.prepare("UPDATE members SET pubkey=NULL WHERE id=? OR name=?").bind(rk[1], decodeURIComponent(rk[1])).run();
        return json({ updated: x.meta.changes });
      }
      const arc = path.match(/^\/v1\/admin\/topics\/(\d+)\/archive$/);
      if (arc && req.method === "POST") {
        const b = await req.json().catch(() => ({}));
        const x = await env.DB.prepare("UPDATE topics SET archived=? WHERE id=?").bind(b.archived === false ? 0 : 1, Number(arc[1])).run();
        return x.meta.changes ? json({ ok: true, archived: b.archived === false ? false : true }) : err(404, "topic not found");
      }
      if (path === "/v1/admin/purge" && req.method === "POST") return json({ deleted: await purge(env, now) });
      return err(404, "not found");
    }

    // ---- member auth ----
    const k = bearer(req);
    if (!k) return err(401, "key required");
    const me = await env.DB.prepare("SELECT * FROM members WHERE key_hash=? AND revoked=0").bind(await sha256(k)).first();
    if (!me) return err(401, "invalid key");
    // Throttled: polling every few seconds must not become a D1 write per request.
    if (now - me.last_seen > 30_000) {
      await env.DB.prepare("UPDATE members SET last_seen=? WHERE id=?").bind(now, me.id).run();
      me.last_seen = now;
    }

    if (path === "/v1/me" && req.method === "GET") return json(pub(me));
    if (path === "/v1/me" && req.method === "PATCH") {
      const b = await req.json().catch(() => ({}));
      const e = await editProfile(env, me, b);
      return e || json(pub(me));
    }
    if (path === "/v1/members" && req.method === "GET") {
      const { results } = await env.DB.prepare("SELECT * FROM members WHERE revoked=0 ORDER BY department,name").all();
      return json(results.map(pub));
    }
    if (path === "/v1/me/key" && req.method === "POST") { // register the device's signing key once
      const b = await req.json().catch(() => ({}));
      if (!validPubkey(b.pubkey)) return err(400, "pubkey must be a base64 raw Ed25519 public key");
      if (me.pubkey) return err(409, "a key is already registered; ask an admin to reset it");
      await env.DB.prepare("UPDATE members SET pubkey=? WHERE id=?").bind(b.pubkey, me.id).run();
      return json({ ok: true });
    }
    if (path === "/v1/messages" && req.method === "POST") {
      const b = await req.json().catch(() => ({}));
      const to = await env.DB.prepare("SELECT id FROM members WHERE (id=? OR name=?) AND revoked=0").bind(b.to, b.to).first();
      if (!to) return err(404, "recipient not found");
      return storeMessage(env, me, b, { kind: "dm", to_id: to.id }, now);
    }
    if (path === "/v1/topics" && req.method === "POST") {
      const b = await req.json().catch(() => ({}));
      const title = clipLine(b.title, 80).trim();
      if (!title) return err(400, "title required");
      const last = await env.DB.prepare("SELECT MAX(created_at) AS t FROM topics WHERE created_by=?").bind(me.id).first();
      if (last?.t && now - last.t < 30_000) return json({ error: "wait before opening another topic", retry_after: Math.ceil((30_000 - (now - last.t)) / 1000) }, 429);
      const r = await env.DB.prepare("INSERT INTO topics (title,created_by,created_at) VALUES (?,?,?)").bind(title, me.id, now).run();
      return json({ id: r.meta.last_row_id, title }, 201);
    }
    if (path === "/v1/topics" && req.method === "GET") {
      const { results } = await env.DB.prepare(
        `SELECT t.id,t.title,t.archived,t.created_at,m.name AS created_by,
                COALESCE((SELECT MAX(id) FROM messages WHERE topic_id=t.id),0) AS last_id,
                (SELECT COUNT(*) FROM messages WHERE topic_id=t.id AND created_at>=?) AS messages
         FROM topics t LEFT JOIN members m ON m.id=t.created_by ORDER BY last_id DESC, t.id DESC LIMIT 200`
      ).bind(cutoff(env, now)).all();
      return json(results.map((t) => ({ ...t, archived: !!t.archived })));
    }
    const tm = path.match(/^\/v1\/topics\/(\d+)\/messages$/);
    if (tm && req.method === "POST") {
      const topic = await env.DB.prepare("SELECT * FROM topics WHERE id=?").bind(Number(tm[1])).first();
      if (!topic) return err(404, "topic not found");
      if (topic.archived) return err(409, "topic is archived");
      const b = await req.json().catch(() => ({}));
      return storeMessage(env, me, b, { kind: "topic", topic_id: topic.id }, now);
    }
    if (tm && req.method === "GET") {
      const since = Number(url.searchParams.get("since") || 0);
      const { results } = await env.DB.prepare(
        `SELECT m.id,m.from_id,m.body,m.created_at,m.ts,m.nonce,m.sig,f.name AS from_name
         FROM messages m JOIN members f ON f.id=m.from_id
         WHERE m.topic_id=? AND m.id>? AND m.created_at>=? ORDER BY m.id LIMIT 200`
      ).bind(Number(tm[1]), since, cutoff(env, now)).all();
      return json(results);
    }
    if (path === "/v1/messages" && req.method === "GET") {
      const since = Number(url.searchParams.get("since") || 0);
      const peer = url.searchParams.get("peer");
      let q = `SELECT m.id,m.from_id,m.to_id,m.body,m.created_at,m.ts,m.nonce,m.sig,f.name AS from_name,t.name AS to_name
               FROM messages m JOIN members f ON f.id=m.from_id JOIN members t ON t.id=m.to_id
               WHERE m.topic_id IS NULL AND m.id>? AND m.created_at>=? AND (m.to_id=? OR m.from_id=?)`;
      const args = [since, cutoff(env, now), me.id, me.id];
      if (peer) { q += " AND (f.name=? OR t.name=?)"; args.push(peer, peer); }
      q += " ORDER BY m.id LIMIT 200";
      const { results } = await env.DB.prepare(q).bind(...args).all();
      return json(results);
    }
    return err(404, "not found");
  },
  // Daily cron (see wrangler.jsonc "triggers"): enforce the retention window.
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(purge(env));
  },
};
