// Additive-only comparison of JSON Schemas (from zod): what a v1 snapshot allows to change.
//
// Allowed (additive): new optional properties, new message types in a union of `{t: …}` messages,
// and enum values or union variants listed in `gated` (introduced behind a federation feature).
// Everything else is breaking: a removed or renamed property, one made required or optional, a
// changed type, pattern or limit (either direction), a removed or ungated enum value or variant.
import { z } from "zod";

export type JsonSchema = {
  [k: string]: unknown;
  type?: string | string[];
  enum?: unknown[];
  const?: unknown;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  additionalProperties?: JsonSchema | boolean;
  propertyNames?: JsonSchema;
};

/** A schema as stored in a snapshot: input JSON Schema without `$schema` and descriptions. */
export function snapshotOf(schema: z.ZodType): JsonSchema {
  const raw = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as JsonSchema;
  return strip(raw) as JsonSchema;
}

function strip(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(strip);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      if (k === "description" || k === "$schema") continue;
      out[k] = strip(x);
    }
    return out;
  }
  return v;
}

const SCALARS = [
  "type",
  "const",
  "pattern",
  "format",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
];

export interface Diff {
  breaking: string[];
  additive: string[];
}

/**
 * `gated` lists additions allowed behind a feature, as `<path>=<value>` (an enum value) or
 * `<path>#<key>` (a union variant keyed by its discriminator value).
 */
export function compare(old: JsonSchema, cur: JsonSchema, gated: string[] = []): Diff {
  const diff: Diff = { breaking: [], additive: [] };
  walk(old, cur, "", diff, new Set(gated));
  return diff;
}

const variants = (s: JsonSchema) => s.anyOf ?? s.oneOf;

/** The property whose `const` tells a union's variants apart (`t` first), if there is one. */
function discriminator(vs: JsonSchema[]): string | undefined {
  const first = vs[0]?.properties ?? {};
  const keys = ["t", ...Object.keys(first).filter((k) => k !== "t")];
  return keys.find((k) => {
    const values = vs.map((v) => v.properties?.[k]?.const);
    return values.every((x) => x !== undefined) && new Set(values.map(String)).size === vs.length;
  });
}

function walk(old: JsonSchema, cur: JsonSchema, path: string, diff: Diff, gated: Set<string>) {
  const at = path || "(root)";
  for (const k of SCALARS) {
    if (JSON.stringify(old[k]) !== JSON.stringify(cur[k])) {
      diff.breaking.push(`${at}: ${k} ${JSON.stringify(old[k])} → ${JSON.stringify(cur[k])}`);
    }
  }
  if (old.enum || cur.enum) {
    const was = new Set((old.enum ?? []).map(String));
    const now = new Set((cur.enum ?? []).map(String));
    for (const v of was) if (!now.has(v)) diff.breaking.push(`${at}: enum value "${v}" removed`);
    for (const v of now) {
      if (was.has(v)) continue;
      if (gated.has(`${path}=${v}`)) diff.additive.push(`${at}: enum value "${v}" (gated)`);
      else diff.breaking.push(`${at}: enum value "${v}" added outside a feature`);
    }
  }
  const ov = variants(old);
  const cv = variants(cur);
  if (ov || cv) {
    if (!ov || !cv) {
      diff.breaking.push(`${at}: union changed shape`);
      return;
    }
    const key = discriminator(ov);
    if (key && discriminator(cv) === key) {
      const byKey = (vs: JsonSchema[]) =>
        new Map(vs.map((v) => [String(v.properties?.[key]?.const), v]));
      const was = byKey(ov);
      const now = byKey(cv);
      for (const [k, v] of was) {
        const n = now.get(k);
        if (!n) diff.breaking.push(`${at}: variant ${key}=${k} removed`);
        else walk(v, n, `${path}#${k}`, diff, gated);
      }
      for (const k of now.keys()) {
        if (was.has(k)) continue;
        // New message types are additive: receivers answer unknown ones "not supported".
        if (key === "t" || gated.has(`${path}#${k}`)) {
          diff.additive.push(`${at}: new variant ${key}=${k}`);
        } else diff.breaking.push(`${at}: variant ${key}=${k} added outside a feature`);
      }
    } else if (ov.length !== cv.length) {
      diff.breaking.push(`${at}: union of ${ov.length} became ${cv.length}`);
    } else {
      ov.forEach((v, i) => {
        walk(v, cv[i] as JsonSchema, `${path}|${i}`, diff, gated);
      });
    }
  }
  if (old.properties || cur.properties) {
    const op = old.properties ?? {};
    const cp = cur.properties ?? {};
    const oreq = new Set(old.required ?? []);
    const creq = new Set(cur.required ?? []);
    for (const [k, v] of Object.entries(op)) {
      const p = path ? `${path}.${k}` : k;
      const n = cp[k];
      if (!n) {
        diff.breaking.push(`${p}: removed or renamed`);
        continue;
      }
      if (oreq.has(k) && !creq.has(k)) diff.breaking.push(`${p}: made optional`);
      if (!oreq.has(k) && creq.has(k)) diff.breaking.push(`${p}: made required`);
      walk(v, n, p, diff, gated);
    }
    for (const k of Object.keys(cp)) {
      if (k in op) continue;
      const p = path ? `${path}.${k}` : k;
      if (creq.has(k)) diff.breaking.push(`${p}: new required field`);
      else diff.additive.push(`${p}: new optional field`);
    }
  }
  if (old.items || cur.items) {
    if (!old.items || !cur.items) diff.breaking.push(`${at}: items changed`);
    else walk(old.items, cur.items, `${path}[]`, diff, gated);
  }
  for (const k of ["additionalProperties", "propertyNames"] as const) {
    const o = old[k];
    const c = cur[k];
    if (typeof o === "object" && typeof c === "object") {
      walk(o as JsonSchema, c as JsonSchema, `${path}{${k}}`, diff, gated);
    } else if (JSON.stringify(o) !== JSON.stringify(c) && k === "propertyNames") {
      diff.breaking.push(`${at}: ${k} changed`);
    } else if (typeof o === "object" && typeof c !== "object") {
      diff.breaking.push(`${at}: ${k} changed`);
    }
  }
}

/** Compares a whole snapshot (name → schema) with the current schemas. */
export function compareAll(
  old: Record<string, JsonSchema>,
  cur: Record<string, JsonSchema>,
  gated: Record<string, string[]> = {},
): Diff {
  const diff: Diff = { breaking: [], additive: [] };
  for (const [name, schema] of Object.entries(old)) {
    const now = cur[name];
    if (!now) {
      diff.breaking.push(`${name}: no longer exported`);
      continue;
    }
    const d = compare(schema, now, gated[name] ?? []);
    diff.breaking.push(...d.breaking.map((x) => `${name} ${x}`));
    diff.additive.push(...d.additive.map((x) => `${name} ${x}`));
  }
  for (const name of Object.keys(cur)) {
    if (!(name in old)) diff.additive.push(`${name}: new schema`);
  }
  return diff;
}
