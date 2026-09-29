// `openloungephone status <url>`: is the server up, does it federate, which versions.
import { WellKnown } from "@openloungephone/federation";
import type { Io } from "./io.ts";

export interface StatusReport {
  url: string;
  healthy: boolean;
  latencyMs?: number;
  software?: string;
  protocol?: number;
  /** Federation version from .well-known, or null when the server doesn't federate. */
  federation?: { version: number; path: string; key: string } | null;
  problems: string[];
}

type Fetch = (req: Request) => Promise<Response>;

async function getJson(fetchFn: Fetch, url: string, timeoutMs: number) {
  const res = await fetchFn(new Request(url, { signal: AbortSignal.timeout(timeoutMs) }));
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: res.status, json };
}

export async function checkStatus(
  url: string,
  fetchFn: Fetch = (r) => fetch(r),
  now: () => number = () => performance.now(),
  timeoutMs = 10_000,
): Promise<StatusReport> {
  const report: StatusReport = { url, healthy: false, problems: [] };
  try {
    const t0 = now();
    const health = await getJson(fetchFn, `${url}/api/health`, timeoutMs);
    report.latencyMs = Math.round(now() - t0);
    const h = health.json as { ok?: unknown; software?: unknown; protocol?: unknown } | undefined;
    if (health.status === 200 && h?.ok === true) {
      report.healthy = true;
      if (typeof h.software === "string") report.software = h.software;
      if (typeof h.protocol === "number") report.protocol = h.protocol;
    } else {
      report.problems.push(`/api/health answered ${health.status}`);
    }
  } catch (e) {
    report.problems.push(`can't reach ${url}: ${(e as Error).message}`);
    return report;
  }
  try {
    const wk = await getJson(fetchFn, `${url}/.well-known/openloungephone`, timeoutMs);
    if (wk.status === 404) report.federation = null;
    else {
      const doc = WellKnown.safeParse(wk.json);
      if (wk.status === 200 && doc.success) {
        report.federation = {
          version: doc.data.version,
          path: doc.data.federation,
          key: doc.data.server_key,
        };
        report.software ??= doc.data.software;
      } else {
        report.problems.push(`/.well-known/openloungephone answered ${wk.status} (not valid)`);
      }
    }
  } catch (e) {
    report.problems.push(`/.well-known/openloungephone: ${(e as Error).message}`);
  }
  return report;
}

export function formatStatus(r: StatusReport): string[] {
  const row = (k: string, v: string) => `  ${k.padEnd(12)}${v}`;
  const lines = [r.url];
  lines.push(
    row(
      "health",
      r.healthy ? `ok${r.latencyMs !== undefined ? ` (${r.latencyMs} ms)` : ""}` : "DOWN",
    ),
  );
  if (r.software) lines.push(row("software", r.software));
  if (r.protocol !== undefined) lines.push(row("protocol", `device protocol v${r.protocol}`));
  if (r.federation === null) lines.push(row("federation", "off (no /.well-known/openloungephone)"));
  else if (r.federation) {
    const k = r.federation.key;
    lines.push(
      row("federation", `v${r.federation.version} at ${r.federation.path}`),
      row("server key", `${k.slice(0, 8)}…${k.slice(-8)}`),
    );
  }
  for (const p of r.problems) lines.push(row("problem", p));
  return lines;
}

export async function status(url: string, json: boolean, io: Io, fetchFn?: Fetch) {
  const report = await checkStatus(url, fetchFn);
  if (json) io.out(JSON.stringify(report, null, 2));
  else for (const l of formatStatus(report)) io.out(l);
  return report.healthy ? 0 : 1;
}
