/**
 * Minimal async SQL surface implemented by both Cloudflare D1 and node:sqlite, so the store is
 * written once. Parameters are positional `?` placeholders.
 */
export type SqlValue = string | number | null;

export interface Sql {
  all<T>(query: string, ...params: SqlValue[]): Promise<T[]>;
  first<T>(query: string, ...params: SqlValue[]): Promise<T | undefined>;
  run(query: string, ...params: SqlValue[]): Promise<{ changes: number }>;
  /** Runs statements atomically. */
  batch(statements: { query: string; params: SqlValue[] }[]): Promise<void>;
}
