/** Adds unknown fields to every object (as a newer peer would), nested objects included. */
export function withUnknownFields(v: unknown, depth = 0): unknown {
  if (Array.isArray(v)) return v.map((x) => withUnknownFields(x, depth + 1));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = withUnknownFields(x, depth + 1);
    return { ...out, zz_future_field: depth, zz_future_obj: { nested: [1, "two"] } };
  }
  return v;
}
