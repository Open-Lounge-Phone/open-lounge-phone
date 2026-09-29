import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import type { AdminFederation, Api, OperatorAuditEntry } from "./api.ts";
import { describeAudit } from "./operatorAudit.ts";

type Overview = Awaited<ReturnType<Api["adminOverview"]>>;
type Found = Awaited<ReturnType<Api["adminFindAccount"]>>;

const when = (ms: number) => new Date(ms).toLocaleString();
const day = (ms: number) => new Date(ms).toLocaleDateString();

/**
 * The operator's admin view: counts, find an account, suspend/exempt, this server's federation
 * key (rotate), other servers' pinned keys (re-trust a refused change, block), blocked servers,
 * and the audit trail of all of it.
 */
export function Admin({
  api,
  sessionToken,
  onBack,
}: {
  api: Api;
  /** For "Copy session for the CLI" (`openloungephone federation rotate-key`). */
  sessionToken?: string;
  onBack(): void;
}) {
  const [overview, setOverview] = useState<Overview>();
  const [fed, setFed] = useState<AdminFederation>();
  const [auditLog, setAuditLog] = useState<OperatorAuditEntry[]>([]);
  const [notice, setNotice] = useState<string>();
  const blockInput = useRef<HTMLInputElement>(null);
  const [handle, setHandle] = useState("");
  const [found, setFound] = useState<Found>();
  const [host, setHost] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    try {
      const [o, f, a] = await Promise.all([
        api.adminOverview(),
        api.adminFederation(),
        api.adminAudit(),
      ]);
      setOverview(o);
      setFed(f);
      setAuditLog(a);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [api]);
  useEffect(() => {
    void load();
  }, [load]);

  const run = async (fn: () => Promise<unknown>) => {
    setError(undefined);
    setNotice(undefined);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    }
    await load();
  };

  const find = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => setFound(await api.adminFindAccount(handle.trim())));
  };
  const refresh = () =>
    found && run(async () => setFound(await api.adminFindAccount(found.handle)));

  const rotate = () => {
    const own = fed?.own;
    if (!own) return;
    const during = own.rotation !== null;
    const text =
      (during
        ? `The last rotation is still being handed over (until ${day(own.rotation?.expiresAt ?? 0)}). ` +
          "Servers that haven't followed it yet will need their operators to re-trust you.\n\n"
        : "") +
      "Rotate this server's federation key?\n\n" +
      "A new key signs from now on. The old key's signed hand-over is published for 7 days; " +
      "servers that talk to you in that time follow by themselves.";
    if (!window.confirm(text)) return;
    void run(async () => {
      const r = await api.adminRotateKey(during);
      setNotice(`Rotated. New key ${r.to}; hand-over published until ${day(r.overlapUntil)}.`);
    });
  };

  const retrust = (p: AdminFederation["peers"][number]) => {
    if (!p.rejected) return;
    const text =
      `Trust ${p.host}'s new key?\n\nPinned key:\n${p.fingerprint}\n\nNew key (no valid ` +
      `hand-over):\n${p.rejected.fingerprint}\n\nOnly do this if ${p.host}'s operator ` +
      "confirmed the new fingerprint to you another way. It replaces the pin.";
    if (!window.confirm(text)) return;
    void run(() => api.adminRetrust(p.host, p.fingerprint, p.rejected?.fingerprint ?? ""));
  };

  /** "Block server" from a pinned key: fills in the block form below. */
  const blockFromList = (h: string) => {
    setHost(h);
    blockInput.current?.scrollIntoView({ block: "center" });
    blockInput.current?.focus();
  };

  const copySession = () => {
    if (!sessionToken) return;
    void navigator.clipboard
      ?.writeText(sessionToken)
      .then(() => setNotice("Copied. Treat it like a password; sign out to end it."))
      .catch(() => setError("Couldn't copy."));
  };

  return (
    <section className="stack admin">
      <button type="button" className="link back" onClick={onBack}>
        ← Back
      </button>
      <h2>Operator</h2>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      {overview && (
        <div className="card">
          <dl className="counts">
            {Object.entries(overview.counts).map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{v.toLocaleString("en-US")}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}

      <form className="card stack" onSubmit={find}>
        <h3>Find an account</h3>
        <label>
          Handle or address
          <input value={handle} onChange={(e) => setHandle(e.target.value)} placeholder="jesse" />
        </label>
        <button type="submit">Find</button>
        {found && (
          <div className="stack">
            <div>
              <strong>{found.name}</strong> <span className="muted">@{found.handle}</span>
            </div>
            <div className="muted small">
              {found.spaces} spaces · this month {found.usage.callMinutes} min,{" "}
              {found.usage.voicemails} voicemails, {found.usage.knocks} knocks
            </div>
            <div className="row">
              <button
                type="button"
                className={found.suspended ? "" : "danger"}
                onClick={() =>
                  void run(() => api.adminSuspend(found.id, !found.suspended)).then(refresh)
                }
              >
                {found.suspended ? "Unsuspend" : "Suspend"}
              </button>
              <button
                type="button"
                onClick={() =>
                  void run(() => api.adminExempt(found.id, !found.exempt)).then(refresh)
                }
              >
                {found.exempt ? "Hold to fair use again" : "Exempt from fair use"}
              </button>
            </div>
          </div>
        )}
      </form>

      <form
        className="card stack"
        onSubmit={(e) => {
          e.preventDefault();
          void run(() => api.adminBlockServer(host.trim(), reason.trim() || undefined)).then(() => {
            setHost("");
            setReason("");
          });
        }}
      >
        <h3>Blocked servers</h3>
        <ul className="stack">
          {(overview?.blockedServers ?? []).map((b) => (
            <li key={b.host} className="row">
              <span>
                {b.host}
                {b.reason ? <span className="muted small"> — {b.reason}</span> : null}
              </span>
              <button type="button" onClick={() => void run(() => api.adminUnblockServer(b.host))}>
                Unblock
              </button>
            </li>
          ))}
        </ul>
        <label>
          Server
          <input
            ref={blockInput}
            value={host}
            onChange={(e) => setHost(e.target.value)}
            placeholder="spam.example"
          />
        </label>
        <label>
          Reason (optional)
          <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} />
        </label>
        <button type="submit" className="danger" disabled={!host.trim()}>
          Block server
        </button>
      </form>

      {fed?.own && (
        <div className="card stack">
          <h3>This server's federation key</h3>
          <div className="small">
            <span className="muted">{fed.own.host}</span>
            <br />
            <code className="key-fp">{fed.own.fingerprint}</code>
          </div>
          {fed.own.rotation && (
            <p className="small muted">
              Rotated {when(fed.own.rotation.createdAt)} from{" "}
              <code className="key-fp">{fed.own.rotation.previousFingerprint}</code>. The hand-over
              is published until {day(fed.own.rotation.expiresAt)}.
            </p>
          )}
          <p className="small muted">
            Other servers pinned this key. Rotating makes a new one; servers that contact you in the
            next 7 days follow by themselves, later ones need their operators.
          </p>
          <div className="row">
            <button type="button" className="danger" onClick={rotate}>
              Rotate key
            </button>
            {sessionToken && (
              <button type="button" onClick={copySession}>
                Copy session for the CLI
              </button>
            )}
          </div>
        </div>
      )}

      {fed && (
        <div className="card stack">
          <h3>Other servers' keys</h3>
          {fed.peers.length === 0 && <p className="small muted">No server contacted yet.</p>}
          <ul className="stack">
            {fed.peers.map((p) => (
              <li
                key={p.host}
                className="stack"
                {...(p.rejected ? { role: "alert" as const } : {})}
              >
                <div className="row">
                  <strong>{p.host}</strong>
                  <span className={p.rejected ? "badge danger" : "badge"}>
                    {p.rejected ? "key change refused" : "pinned"}
                  </span>
                  {p.blocked && <span className="badge">blocked</span>}
                </div>
                <div className="small muted">
                  <code className="key-fp">{p.fingerprint}</code>
                  <br />
                  first seen {day(p.firstSeen)}
                  {p.keySince !== p.firstSeen ? `, this key since ${day(p.keySince)}` : ""}
                </div>
                {p.rejected && (
                  <div className="small">
                    Presented a different key on {when(p.rejected.at)} without a valid hand-over:
                    <br />
                    <code className="key-fp">{p.rejected.fingerprint}</code>
                    <br />
                    Check with its operator before trusting it.
                  </div>
                )}
                <div className="row">
                  {p.rejected && (
                    <button type="button" onClick={() => retrust(p)}>
                      Re-trust…
                    </button>
                  )}
                  {!p.blocked && (
                    <button type="button" className="link" onClick={() => blockFromList(p.host)}>
                      Block server…
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="card stack">
        <h3>Audit trail</h3>
        {auditLog.length === 0 && <p className="small muted">Nothing yet.</p>}
        <ul className="stack small">
          {auditLog.map((e) => (
            <li key={e.id}>
              <span className="muted">{when(e.at)}</span> — {describeAudit(e)}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
