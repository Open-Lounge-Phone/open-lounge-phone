import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type { Sql, SqlValue } from "./sql.ts";

export const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));

/** Opens (or creates) a SQLite database; pass ":memory:" for tests. */
export function openSqlite(path: string): { sql: Sql; db: DatabaseSync } {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  const args = (params: SqlValue[]) => params as SQLInputValue[];
  const sql: Sql = {
    async all<T>(query: string, ...params: SqlValue[]) {
      return db.prepare(query).all(...args(params)) as T[];
    },
    async first<T>(query: string, ...params: SqlValue[]) {
      return db.prepare(query).get(...args(params)) as T | undefined;
    },
    async run(query: string, ...params: SqlValue[]) {
      return { changes: Number(db.prepare(query).run(...args(params)).changes) };
    },
    async batch(statements) {
      db.exec("BEGIN");
      try {
        for (const s of statements) db.prepare(s.query).run(...args(s.params));
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  };
  return { sql, db };
}

/**
 * Applies pending `NNNN_name.sql` migrations in order. Uses the same `d1_migrations` table as
 * `wrangler d1 migrations`, so a database can move between backends.
 */
export function migrate(db: DatabaseSync, dir: string = MIGRATIONS_DIR): string[] {
  db.exec(`CREATE TABLE IF NOT EXISTS d1_migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE,
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
  )`);
  const applied = new Set(
    (db.prepare("SELECT name FROM d1_migrations").all() as { name: string }[]).map((r) => r.name),
  );
  const pending = readdirSync(dir)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f) && !applied.has(f))
    .sort();
  for (const name of pending) {
    db.exec("BEGIN");
    try {
      db.exec(readFileSync(`${dir}/${name}`, "utf8"));
      db.prepare("INSERT INTO d1_migrations (name) VALUES (?)").run(name);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw new Error(`migration ${name} failed: ${(e as Error).message}`);
    }
  }
  return pending;
}
