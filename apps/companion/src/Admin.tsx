import { type FormEvent, useCallback, useEffect, useState } from "react";
import type { Api } from "./api.ts";

type Overview = Awaited<ReturnType<Api["adminOverview"]>>;
type Found = Awaited<ReturnType<Api["adminFindAccount"]>>;

/** The operator's minimal admin view: counts, find an account, suspend/exempt, block servers. */
export function Admin({ api, onBack }: { api: Api; onBack(): void }) {
  const [overview, setOverview] = useState<Overview>();
  const [handle, setHandle] = useState("");
  const [found, setFound] = useState<Found>();
  const [host, setHost] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    try {
      setOverview(await api.adminOverview());
    } catch (e) {
      setError((e as Error).message);
    }
  }, [api]);
  useEffect(() => {
    void load();
  }, [load]);

  const run = async (fn: () => Promise<unknown>) => {
    setError(undefined);
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

      {(overview?.keyAlerts ?? []).length > 0 && (
        <div className="card stack" role="alert">
          <h3>Server key changes refused</h3>
          <p className="small muted">
            These servers presented a different key than the one pinned. Check with their operator
            before trusting them again.
          </p>
          <ul>
            {overview?.keyAlerts.map((k) => (
              <li key={k.host}>
                {k.host} — {new Date(k.rejectedAt).toLocaleString()}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
