// Plain-language lines for the operators' audit trail (Operator view).
import type { OperatorAuditEntry } from "./api.ts";

const short = (fp: unknown) =>
  typeof fp === "string" ? `${fp.replace(/^SHA256:/, "").slice(0, 12)}…` : "?";

export function describeAudit(e: OperatorAuditEntry): string {
  const d = e.detail ?? {};
  const who = e.actorAccount ? e.actorName : "Automatically";
  const host = String(d.host ?? "");
  const handle = d.handle ? `@${String(d.handle)}` : "an account";
  switch (e.action) {
    case "fedkey.rotate":
      return `${who} rotated this server's key (${short(d.from)} → ${short(d.to)})${d.forced ? ", during an overlap" : ""}`;
    case "fedkey.rotated":
      return `${host} rotated its key; followed its signed hand-over (${short(d.from)} → ${short(d.to)})`;
    case "fedkey.refused":
      return `${host} presented a new key without a valid hand-over; refused (${short(d.to)})`;
    case "fedkey.retrust":
      return `${who} re-trusted ${host} (${short(d.from)} → ${short(d.to)})`;
    case "server.block":
      return `${who} blocked ${host}${d.reason ? ` (${String(d.reason)})` : ""}`;
    case "server.unblock":
      return `${who} unblocked ${host}`;
    case "account.suspend":
      return `${who} suspended ${handle}`;
    case "account.unsuspend":
      return `${who} unsuspended ${handle}`;
    case "account.exempt":
      return `${who} exempted ${handle} from fair use`;
    case "account.unexempt":
      return `${who} held ${handle} to fair use again`;
    default:
      return `${who}: ${e.action}`;
  }
}
