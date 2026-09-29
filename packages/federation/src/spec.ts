// Renders the generated parts of docs/federation-spec.md from the zod schemas (the endpoint
// reference and the stream frames), so the spec can't drift from the code. The prose around them
// is written by hand. `npm run docs:federation` rewrites the blocks; spec.test.ts checks them.

import { VoicemailOffer } from "@openloungephone/protocol";
import { z } from "zod";
import { FED_ENDPOINTS, type FedEndpoint } from "./endpoints.ts";
import {
  CallEndReason,
  CallTarget,
  FedErrorBody,
  FedSignal,
  MAX_FED_BODY_BYTES,
  MAX_FED_VOICEMAIL_BYTES,
  Party,
  RoomSignalMsg,
  StreamHello,
} from "./messages.ts";
import { MAX_SKEW_S, NONCE_TTL_MS } from "./signature.ts";
import { FEDERATION_PATH, FEDERATION_VERSION } from "./wellKnown.ts";

type JsonSchema = {
  description?: string;
  type?: string | string[];
  enum?: unknown[];
  const?: unknown;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  pattern?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
};

const json = (s: z.ZodType) => z.toJSONSchema(s, { io: "input" }) as JsonSchema;

/** Shared types, shown by name in the tables and defined once (see `renderTypes`). */
const NAMED: [string, z.ZodType][] = [
  ["Party", Party],
  ["CallTarget", CallTarget],
  ["VoicemailOffer", VoicemailOffer],
];
const named = new Map(
  NAMED.map(([name, schema]) => {
    const { $schema: _, ...rest } = json(schema) as JsonSchema & { $schema?: string };
    return [JSON.stringify(rest), name];
  }),
);

function typeOf(s: JsonSchema, top = false): string {
  const name = top ? undefined : named.get(JSON.stringify(s));
  if (name) return `\`${name}\``;
  if (s.const !== undefined) return `\`${JSON.stringify(s.const)}\``;
  if (s.enum) return s.enum.map((v) => `\`${JSON.stringify(v)}\``).join(" \\| ");
  const alts = s.anyOf ?? s.oneOf;
  if (alts) return alts.map((a) => typeOf(a)).join(" \\| ");
  if (s.type === "array" && s.items) {
    const n = s.maxItems !== undefined ? ` (${s.minItems ?? 0}–${s.maxItems})` : "";
    const item = typeOf(s.items);
    return `${item.includes(" \\| ") ? `(${item})` : item}[]${n}`;
  }
  if (s.type === "object" && s.properties) {
    return `{ ${Object.entries(s.properties)
      .map(([k, v]) => `${k}${s.required?.includes(k) ? "" : "?"}: ${typeOf(v)}`)
      .join(", ")} }`;
  }
  const t = Array.isArray(s.type) ? s.type.join(" \\| ") : (s.type ?? "any");
  const bounds: string[] = [];
  if (s.minimum !== undefined && s.minimum > Number.MIN_SAFE_INTEGER) bounds.push(`≥${s.minimum}`);
  if (s.maximum !== undefined && s.maximum < Number.MAX_SAFE_INTEGER) bounds.push(`≤${s.maximum}`);
  if (s.minLength !== undefined && s.minLength === s.maxLength) bounds.push(`len ${s.minLength}`);
  else {
    if (s.minLength !== undefined && s.minLength > 0) bounds.push(`len ≥${s.minLength}`);
    if (s.maxLength !== undefined) bounds.push(`len ≤${s.maxLength}`);
  }
  if (s.pattern) bounds.push(`\`${s.pattern}\``);
  return bounds.length ? `${t} (${bounds.join(", ")})` : t;
}

const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\n/g, " ");

/** A field table for an object schema. */
function fields(schema: z.ZodType): string[] {
  const s = json(schema);
  const out = ["| Field | Type | Required | Notes |", "|---|---|---|---|"];
  for (const [name, p] of Object.entries(s.properties ?? {})) {
    const required = s.required?.includes(name) ? "yes" : "";
    out.push(`| \`${name}\` | ${typeOf(p)} | ${required} | ${cell(p.description ?? "")} |`);
  }
  return out;
}

function endpoint(e: FedEndpoint): string[] {
  const out = [`### \`${e.method} ${e.path}\``, "", e.summary, ""];
  out.push(
    e.signed
      ? "Signed (RFC 9421 profile, §4). Unsigned or badly signed requests get `401`."
      : "Not signed.",
    "",
  );
  if (e.query) out.push("**Query parameters**", "", ...fields(e.query), "");
  if (e.body) out.push("**Request body** (`application/json`)", "", ...fields(e.body), "");
  if (e.bodyNote) out.push(`**Request body:** ${e.bodyNote}`, "");
  out.push("**Responses**", "", "| Status | Body | Meaning |", "|---|---|---|");
  for (const r of e.responses) {
    const body = r.schema ? typeOf(json(r.schema)) : "—";
    out.push(`| ${r.status} | ${body} | ${cell(r.note)} |`);
  }
  out.push("");
  if (e.rules.length) {
    out.push("**Receiver rules**", "");
    for (const rule of e.rules) out.push(`- ${rule}`);
    out.push("");
  }
  return out;
}

/** The discriminators a union of `{t: …}` messages allows. */
function kinds(union: z.ZodType): string {
  const s = json(union);
  return (s.anyOf ?? s.oneOf ?? []).map((v) => `\`${String(v.properties?.t?.const)}\``).join(", ");
}

export function renderEndpoints(): string {
  const out = [
    `Federation version ${FEDERATION_VERSION}, base path \`${FEDERATION_PATH}\`. JSON bodies are at most ${MAX_FED_BODY_BYTES} bytes; voicemail audio at most ${MAX_FED_VOICEMAIL_BYTES} bytes. Every refusal carries ${typeOf(json(FedErrorBody))}.`,
    "",
    "| Endpoint | Signed | Summary |",
    "|---|---|---|",
    ...FED_ENDPOINTS.map(
      (e) => `| \`${e.method} ${e.path}\` | ${e.signed ? "yes" : "no"} | ${cell(e.summary)} |`,
    ),
    "",
  ];
  for (const e of FED_ENDPOINTS) out.push(...endpoint(e));
  out.push(
    "**Call end reasons** (`CallResult.reason`, `call.state.reason`): " +
      (json(CallEndReason).enum ?? []).map((v) => `\`${v}\``).join(", "),
    "",
  );
  return out.join("\n").trimEnd();
}

/** The shared types' definitions. */
export function renderTypes(): string {
  const out: string[] = [];
  for (const [name, schema] of NAMED) {
    const s = json(schema);
    out.push(`#### \`${name}\``, "");
    if (s.description) out.push(s.description, "");
    const alts = s.anyOf ?? s.oneOf;
    if (alts) {
      out.push("One of:", "");
      for (const alt of alts) out.push(`- ${typeOf(alt, true)}`);
      out.push("");
    } else out.push(...fields(schema), "");
  }
  return out.join("\n").trimEnd();
}

export function renderStream(): string {
  return [
    "**Handshake frames** (`hello` from the dialer, `hello.ok` from the acceptor)",
    "",
    ...fields(StreamHello),
    "",
    `**Signal frames** — \`{"t": "signal", "msg": …}\`, where \`msg\` is one of ${kinds(FedSignal)} (the shapes in [protocol.md](protocol.md), with \`callId\` naming the call or room leg on the receiving side).`,
    "",
    `**Room signals** — \`msg\` of a \`room.signal\` is one of ${kinds(RoomSignalMsg)}.`,
    "",
    `**Timing constants** — signature and \`hello\` freshness ±${MAX_SKEW_S} s; nonces remembered ${NONCE_TTL_MS / 60_000} minutes.`,
  ].join("\n");
}

/** Replaces each `<!-- BEGIN GENERATED: name -->…<!-- END GENERATED: name -->` block. */
export function fillSpec(doc: string): string {
  const blocks: Record<string, () => string> = {
    endpoints: renderEndpoints,
    types: renderTypes,
    stream: renderStream,
  };
  let out = doc;
  for (const [name, render] of Object.entries(blocks)) {
    const begin = `<!-- BEGIN GENERATED: ${name} (npm run docs:federation) -->`;
    const end = `<!-- END GENERATED: ${name} -->`;
    const a = out.indexOf(begin);
    const b = out.indexOf(end);
    if (a < 0 || b < a) throw new Error(`docs/federation-spec.md has no "${name}" block`);
    out = `${out.slice(0, a + begin.length)}\n${render()}\n${out.slice(b)}`;
  }
  return out;
}
