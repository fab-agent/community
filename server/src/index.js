// fab-community: tiny community server (members + direct messages) for the Herdr plugin.
// Auth: per-member key (Bearer). Admin: ADMIN_KEY secret. Keys are stored as SHA-256 hashes.
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const err = (status, message) => json({ error: message }, status);

const sha256 = async (s) => {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
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
  id: m.id, name: m.name, department: m.department, title: m.title, task: m.task,
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

    // ---- admin ----
    if (path.startsWith("/v1/admin/")) {
      if (!env.ADMIN_KEY || !safeEq(bearer(req), env.ADMIN_KEY)) return err(401, "admin key required");
      if (path === "/v1/admin/members" && req.method === "POST") {
        const b = await req.json().catch(() => ({}));
        const name = clip(b.name, 40).trim();
        if (!name) return err(400, "name required");
        const key = randomKey();
        const id = crypto.randomUUID();
        try {
          await env.DB.prepare(
            "INSERT INTO members (id,name,department,title,task,key_hash,created_at) VALUES (?,?,?,?,?,?,?)"
          ).bind(id, name, clip(b.department, 60), clip(b.title, 60), clip(b.task, 200), await sha256(key), now).run();
        } catch (e) { return err(409, "name already exists"); }
        return json({ id, name, key }, 201);
      }
      if (path === "/v1/admin/members" && req.method === "GET") {
        const { results } = await env.DB.prepare("SELECT * FROM members ORDER BY name").all();
        return json(results.map((m) => ({ ...pub(m), revoked: !!m.revoked })));
      }
      if (path === "/v1/admin/purge" && req.method === "POST") return json({ deleted: await purge(env, now) });
      const rev = path.match(/^\/v1\/admin\/members\/([^/]+)\/revoke$/);
      if (rev && req.method === "POST") {
        await env.DB.prepare("UPDATE members SET revoked=1 WHERE id=? OR name=?").bind(rev[1], decodeURIComponent(rev[1])).run();
        return json({ ok: true });
      }
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
      const f = {
        task: b.task !== undefined ? clip(b.task, 200) : me.task,
        title: b.title !== undefined ? clip(b.title, 60) : me.title,
        department: b.department !== undefined ? clip(b.department, 60) : me.department,
      };
      await env.DB.prepare("UPDATE members SET task=?,title=?,department=? WHERE id=?").bind(f.task, f.title, f.department, me.id).run();
      return json(pub({ ...me, ...f }));
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
