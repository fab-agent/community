// Minimal D1 look-alike on top of node:sqlite so the Worker can run under plain `node --test`.
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";

export function makeDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(fs.readFileSync(new URL("../server/schema.sql", import.meta.url), "utf8"));
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => {
      const r = db.prepare(sql).run(...args);
      return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
    },
  });
  return { prepare: (sql) => stmt(sql), raw: db };
}
