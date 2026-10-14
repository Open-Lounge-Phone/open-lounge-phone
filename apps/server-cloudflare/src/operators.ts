// Operators are account ids (`acc_…`), never handles: a handle can be renamed, released and
// taken by someone else. `deploy.ts --operator <handle>` turns handles into ids once, by asking
// the instance's own D1 database, and keeps the ids (instances/<name>.json).

/** A handle as accounts store them (see HANDLE_RE in packages/db). */
const HANDLE = /^[a-z0-9._-]{2,30}$/;
/** An account id as `newId("acc")` makes them. */
export const ACCOUNT_ID = /^acc_[A-Za-z0-9_-]{8,64}$/;

/** One D1 query through wrangler: rows of the first result set. */
export type D1Query = (sql: string) => Record<string, unknown>[];

export interface ResolvedOperator {
  handle: string | null;
  id: string;
}

/**
 * Resolves `--operator a,b,acc_X`: account ids are kept as given (after checking they exist),
 * handles are looked up. Throws, naming what's missing, when any isn't an account here.
 */
export function resolveOperators(spec: string, query: D1Query): ResolvedOperator[] {
  const entries = spec
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (ACCOUNT_ID.test(s) ? s : s.toLowerCase().replace(/^@/, "").replace(/@.*$/, "")));
  if (entries.length === 0) throw new Error("--operator needs a handle or an account id");
  for (const e of entries) {
    // Only these shapes reach the SQL below (it can't carry anything else).
    if (!ACCOUNT_ID.test(e) && !HANDLE.test(e)) throw new Error(`not a handle: ${e}`);
  }
  const list = entries.map((e) => `'${e}'`).join(", ");
  const rows = query(
    `SELECT id, handle FROM accounts WHERE handle IN (${list}) OR id IN (${list})`,
  ) as { id: string; handle: string }[];
  const missing: string[] = [];
  const found: ResolvedOperator[] = [];
  for (const e of entries) {
    const row = rows.find((r) => r.id === e || r.handle === e);
    if (!row) missing.push(e);
    else if (!found.some((f) => f.id === row.id)) found.push({ handle: row.handle, id: row.id });
  }
  if (missing.length) {
    throw new Error(
      `no account with ${missing.length === 1 ? "this handle" : "these handles"} on this instance: ${missing.join(", ")}. ` +
        "Sign up (or sign in once) first, then deploy again.",
    );
  }
  return found;
}

/** Rows from `wrangler d1 execute … --json` output. */
export function d1Rows(stdout: string): Record<string, unknown>[] {
  const parsed = JSON.parse(stdout) as { results?: Record<string, unknown>[] }[];
  return parsed[0]?.results ?? [];
}
