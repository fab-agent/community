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
  last_seen: m.last_seen, online: Date.now() - m.last_seen < 90_000,
});
const clip = (v, n) => String(v ?? "").slice(0, n);

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
  if (b.title !== undefined) f.title = clip(b.title, 60);
  if (b.department !== undefined) f.department = clip(b.department, 60);
  if (b.task !== undefined) f.task = clip(b.task, 200);
  if (b.name !== undefined) {
    const name = clip(b.name, 40).trim();
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
      const code = clip(b.code, 64).trim();
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
      // A removed member keeps their message history but frees the name for re-invites.
      await env.DB.prepare("UPDATE members SET name=name||' ['||substr(id,1,6)||']' WHERE name=? AND revoked=1").bind(inv.name).run();
      try {
        await env.DB.prepare(
          "INSERT INTO members (id,name,department,title,role,key_hash,created_at) VALUES (?,?,?,?,?,?,?)"
        ).bind(id, inv.name, inv.department, inv.title, inv.role, await sha256(key), now).run();
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
        const name = clip(b.name, 40).trim();
        if (!name) return err(400, "name required");
        if (await env.DB.prepare("SELECT 1 FROM members WHERE name=? AND revoked=0").bind(name).first()) return err(409, "name already exists");
        const hours = Math.min(Math.max(Number(b.ttl_hours) || 1, 1), 24 * 14);
        const role = b.role === "admin" ? "admin" : "member";
        const code = randomCode();
        const expires_at = now + hours * 3_600_000;
        await env.DB.prepare(
          "INSERT INTO invites (code_hash,name,department,title,role,created_by,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?)"
        ).bind(await sha256(code), name, clip(b.department, 60), clip(b.title, 60), role, by, now, expires_at).run();
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
        const name = clip(b.name, 40).trim();
        if (!name) return err(400, "name required");
        const key = randomKey();
        const id = crypto.randomUUID();
        try {
          await env.DB.prepare(
            "INSERT INTO members (id,name,department,title,task,role,key_hash,created_at) VALUES (?,?,?,?,?,?,?,?)"
          ).bind(id, name, clip(b.department, 60), clip(b.title, 60), clip(b.task, 200), b.role === "admin" ? "admin" : "member", await sha256(key), now).run();
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
      if (path === "/v1/admin/purge" && req.method === "POST") return json({ deleted: await purge(env, now) });
      return err(404, "not found");
    }

    // ---- member auth ----
    const k = bearer(req);
    if (!k) return err(401, "key required");
    const me = await env.DB.prepare("SELECT * FROM members WHERE key_hash=? AND revoked=0").bind(await sha256(k)).first();
    if (!me) return err(401, "invalid key");
    await env.DB.prepare("UPDATE members SET last_seen=? WHERE id=?").bind(now, me.id).run();
    me.last_seen = now;

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
    if (path === "/v1/messages" && req.method === "POST") {
      const b = await req.json().catch(() => ({}));
      const body = clip(b.body, 4000).trim();
      if (!body) return err(400, "body required");
      const to = await env.DB.prepare("SELECT id FROM members WHERE (id=? OR name=?) AND revoked=0").bind(b.to, b.to).first();
      if (!to) return err(404, "recipient not found");
      const r = await env.DB.prepare("INSERT INTO messages (from_id,to_id,body,created_at) VALUES (?,?,?,?)")
        .bind(me.id, to.id, body, now).run();
      return json({ id: r.meta.last_row_id }, 201);
    }
    if (path === "/v1/messages" && req.method === "GET") {
      const since = Number(url.searchParams.get("since") || 0);
      const peer = url.searchParams.get("peer");
      let q = `SELECT m.id,m.from_id,m.to_id,m.body,m.created_at,f.name AS from_name,t.name AS to_name
               FROM messages m JOIN members f ON f.id=m.from_id JOIN members t ON t.id=m.to_id
               WHERE m.id>? AND m.created_at>=? AND (m.to_id=? OR m.from_id=?)`;
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
