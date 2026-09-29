// `openloungephone federation rotate-key --url <server>`: rotates a server's federation key with
// an operator's session (the same action as the Operator view's button). Works the same for
// Cloudflare and self-hosted servers: the server makes the key and keeps it; this command never
// sees, prints or stores a private key, only fingerprints.
import type { Io } from "./io.ts";

export interface RotateOptions {
  url: string;
  force: boolean;
  yes: boolean;
}

type Fetch = (req: Request) => Promise<Response>;

interface FedView {
  own: {
    host: string;
    fingerprint: string;
    rotation: { previousFingerprint: string; expiresAt: number } | null;
  } | null;
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");

export async function rotateKey(
  opts: RotateOptions,
  io: Io,
  env: Record<string, string | undefined>,
  fetchFn: Fetch = (r) => fetch(r),
): Promise<number> {
  const token =
    env.OLP_SESSION_TOKEN?.trim() ||
    (io.interactive ? await io.askSecret("Operator session token (Operator view → Copy)") : "");
  if (!token) {
    io.err(
      "needs an operator's session: set OLP_SESSION_TOKEN (Operator view → \"Copy session for " +
        'the CLI") or run it in a terminal to be asked.',
    );
    return 2;
  }
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetchFn(
      new Request(`${opts.url}/api${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
    );
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {}
    return { status: res.status, json };
  };
  const view = await call("GET", "/admin/federation");
  if (view.status === 401 || view.status === 403) {
    io.err(`${opts.url}: that session isn't an operator's (answered ${view.status}).`);
    return 1;
  }
  if (view.status !== 200) {
    io.err(`${opts.url}: answered ${view.status} ${String(view.json.error ?? "")}`.trim());
    return 1;
  }
  const own = (view.json as unknown as FedView).own;
  if (!own) {
    io.err(`${opts.url} doesn't federate (no server key).`);
    return 1;
  }
  io.out(`${own.host}`);
  io.out(`  current key  ${own.fingerprint}`);
  if (own.rotation) {
    io.out(
      `  rotating     from ${own.rotation.previousFingerprint}, published until ${day(own.rotation.expiresAt)} UTC`,
    );
    if (!opts.force) {
      io.err(
        "The last rotation is still in its overlap window: servers that haven't followed it yet " +
          "would need their operators to re-trust you. Wait, or pass --force.",
      );
      return 1;
    }
  }
  io.out("");
  io.out("A new key will sign from now on. The old one hands over to it in");
  io.out("/.well-known/openloungephone for 7 days; servers that talk to you in that time");
  io.out("follow by themselves, others need their operator to re-trust you.");
  if (!opts.yes) {
    if (!io.interactive) {
      io.err("not a terminal: pass --yes to rotate without asking.");
      return 2;
    }
    if (!(await io.confirm("Rotate the key now?", false))) {
      io.out("Nothing changed.");
      return 1;
    }
  }
  const r = await call("POST", "/admin/federation/rotate-key", opts.force ? { force: true } : {});
  if (r.status !== 200) {
    io.err(`rotation refused (${r.status}): ${String(r.json.error ?? "")}`);
    return 1;
  }
  io.out(`Rotated.`);
  io.out(`  old key      ${String(r.json.from)}`);
  io.out(`  new key      ${String(r.json.to)}`);
  io.out(`  hand-over published until ${day(Number(r.json.overlapUntil))} UTC`);
  return 0;
}
