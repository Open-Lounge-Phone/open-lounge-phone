import type { Sql, SqlValue } from "./sql.ts";

/** The subset of Cloudflare's D1Database used here (avoids a dependency on workers-types). */
interface D1Like {
  prepare(query: string): {
    bind(...values: unknown[]): {
      all<T>(): Promise<{ results: T[] }>;
      first<T>(): Promise<T | null>;
      run(): Promise<{ meta: { changes: number } }>;
    };
  };
  batch(statements: unknown[]): Promise<unknown>;
}

export function d1Sql(db: D1Like): Sql {
  const stmt = (query: string, params: SqlValue[]) => db.prepare(query).bind(...params);
  return {
    async all<T>(query: string, ...params: SqlValue[]) {
      return (await stmt(query, params).all<T>()).results;
    },
    async first<T>(query: string, ...params: SqlValue[]) {
      return (await stmt(query, params).first<T>()) ?? undefined;
    },
    async run(query: string, ...params: SqlValue[]) {
      return { changes: (await stmt(query, params).run()).meta.changes };
    },
    async batch(statements) {
      await db.batch(statements.map((s) => stmt(s.query, s.params)));
    },
  };
}
