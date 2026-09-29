import { type FormEvent, useCallback, useEffect, useState } from "react";
import { renderSVG } from "uqr";
import type { Api, ConnectionsInfo, ConnectionView } from "./api.ts";
import { daysLeft, groupConnections, hostBadge } from "./connectionGroups.ts";

interface Props {
  api: Api;
  /** Bumped by the server when something changed (knock arrived, accepted…). */
  refreshKey: number;
  onBack(): void;
  /** Tells the header how many knocks are waiting. */
  onRequests(n: number): void;
  /** Call someone you're connected with (any server). */
  onCall?: ((c: ConnectionView) => void) | undefined;
  /** Call a household phone they shared with you. */
  onCallPhone?:
    | ((c: ConnectionView, phone: { deviceId: string; label: string }) => void)
    | undefined;
}

/**
 * Connections: grown-ups you can reach, on this server or others. Knock on an address, answer
 * knocks, and block people or whole servers. Kids' phones are never knockable; a guardian can
 * put a connection on a phone's allow-list from the phone's page.
 */
export function Connections({ api, refreshKey, onBack, onRequests, onCall, onCallPhone }: Props) {
  const [info, setInfo] = useState<ConnectionsInfo>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [showQr, setShowQr] = useState(false);

  const load = useCallback(async () => {
    try {
      const next = await api.connections();
      setInfo(next);
      onRequests(groupConnections(next.connections).requests.length);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [api, onRequests]);

  useEffect(() => {
    void refreshKey;
    void load();
  }, [load, refreshKey]);

  const run = async (fn: () => Promise<unknown>, done?: string) => {
    setError(undefined);
    setNotice(undefined);
    try {
      await fn();
      if (done) setNotice(done);
    } catch (e) {
      setError((e as Error).message);
    }
    await load();
  };

  const groups = groupConnections(info?.connections ?? []);
  const now = Date.now();

  return (
    <section className="stack connections">
      <button type="button" className="link back" onClick={onBack}>
        ← Back
      </button>
      <h2>Connections</h2>
      <p className="muted">
        Grown-ups you can call, on this server or any other Open Lounge Phone server. Share your
        address; people knock, and you decide. Nobody can call you until you accept.
      </p>
      {info && (
        <div className="card stack">
          <span className="small muted">Your address</span>
          <div className="row">
            <code className="address">{info.address}</code>
            <button
              type="button"
              onClick={() =>
                void navigator.clipboard?.writeText(info.address).then(
                  () => setNotice("Address copied."),
                  () => setError("Couldn't copy; select it instead."),
                )
              }
            >
              Copy
            </button>
            <button type="button" onClick={() => setShowQr((v) => !v)} aria-expanded={showQr}>
              QR code
            </button>
          </div>
          {showQr && (
            <div
              className="qr"
              role="img"
              aria-label={`QR code for ${info.address}`}
              // biome-ignore lint/security/noDangerouslySetInnerHtml: SVG generated locally by uqr
              dangerouslySetInnerHTML={{ __html: renderSVG(info.address, { border: 2 }) }}
            />
          )}
          {!info.federates && (
            <span className="hint">This server only connects people on this server.</span>
          )}
          <label className="check">
            <input
              type="checkbox"
              checked={info.sharePresence ?? false}
              onChange={(e) =>
                void run(() => api.updateAccount({ sharePresence: e.target.checked }))
              }
            />
            <span>
              Share my availability with my connections
              <span className="hint"> — they see whether you're online and taking calls.</span>
            </span>
          </label>
        </div>
      )}
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

      <KnockForm
        onKnock={(to, note) =>
          run(async () => {
            const r = await api.knock(to, note);
            if (r.status === "connected") setNotice(`You're connected with ${to}.`);
            else setNotice(`Knock sent to ${to}. You'll be connected when they accept.`);
          })
        }
      />

      {groups.requests.length > 0 && (
        <>
          <h3>Knocks for you</h3>
          <ul className="stack">
            {groups.requests.map((c) => (
              <li key={c.id} className="card stack">
                <Who c={c} />
                {c.note && <blockquote className="note">“{c.note}”</blockquote>}
                <div className="row">
                  <button
                    type="button"
                    className="primary"
                    onClick={() =>
                      void run(() => api.acceptConnection(c.id), `Connected with ${c.name}.`)
                    }
                  >
                    Accept
                  </button>
                  <button type="button" onClick={() => void run(() => api.declineConnection(c.id))}>
                    Decline
                  </button>
                  <button
                    type="button"
                    className="danger"
                    onClick={() =>
                      void run(() => api.blockConnection(c.id), `Blocked ${c.address}.`)
                    }
                  >
                    Block
                  </button>
                </div>
                <span className="hint">
                  Declining is silent; they can't knock again for 30 days.
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      <h3>Connected</h3>
      {groups.connected.length === 0 ? (
        <p className="muted small">Nobody yet. Knock on someone's address above.</p>
      ) : (
        <ul className="stack">
          {groups.connected.map((c) => (
            <li key={c.id} className="card stack">
              <div className="person">
                <Who c={c} />
                <div className="row">
                  {onCall && (
                    <button type="button" className="primary" onClick={() => onCall(c)}>
                      Call
                    </button>
                  )}
                  <details className="more">
                    <summary>More</summary>
                    <button
                      type="button"
                      onClick={() => void run(() => api.removeConnection(c.id))}
                    >
                      Disconnect
                    </button>
                    <button
                      type="button"
                      className="danger"
                      onClick={() =>
                        void run(() => api.blockConnection(c.id), `Blocked ${c.address}.`)
                      }
                    >
                      Block
                    </button>
                  </details>
                </div>
              </div>
              {(c.phones ?? []).length > 0 && (
                <ul className="shared-phones">
                  {(c.phones ?? []).map((p) => (
                    <li key={p.deviceId} className="row">
                      <span>
                        {p.label} <span className="muted small">— their household phone</span>
                      </span>
                      {onCallPhone && (
                        <button type="button" onClick={() => onCallPhone(c, p)}>
                          Call
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}

      {groups.waiting.length > 0 && (
        <>
          <h3>Waiting for an answer</h3>
          <ul className="stack">
            {groups.waiting.map((c) => {
              const days = daysLeft(c.expiresAt, now);
              return (
                <li key={c.id} className="card person">
                  <div>
                    <div className="device-name">{c.address}</div>
                    <div className="muted small">
                      Knocked{days !== undefined ? ` · expires in ${days} days` : ""}
                    </div>
                  </div>
                  <button type="button" onClick={() => void run(() => api.removeConnection(c.id))}>
                    Cancel
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}

      <Blocked
        people={groups.blocked}
        servers={info?.blockedServers ?? []}
        onUnblock={(id) => void run(() => api.removeConnection(id))}
        onBlockServer={(host) => run(() => api.blockServer(host), `Blocked everyone on ${host}.`)}
      />
    </section>
  );
}

function Who({ c }: { c: ConnectionView }) {
  const badge = hostBadge(c);
  const p = c.presence;
  const dot = !p ? undefined : !p.online ? "offline" : p.available ? "online" : "busy";
  return (
    <div>
      <div className="device-name">
        {dot && (
          <span
            className={`dot ${dot === "online" ? "on" : dot === "busy" ? "away" : "off"}`}
            role="img"
            aria-label={
              dot === "online" ? "Available" : dot === "busy" ? "Not taking calls" : "Offline"
            }
          />
        )}
        {c.name}
        {badge && (
          <span className="badge" title="On another server">
            {badge}
          </span>
        )}
      </div>
      <div className="muted small">{c.address}</div>
    </div>
  );
}

function KnockForm({ onKnock }: { onKnock(to: string, note?: string): Promise<void> }) {
  const [to, setTo] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    await onKnock(to.trim(), note.trim() || undefined);
    setBusy(false);
    setTo("");
    setNote("");
  };
  return (
    <form className="card stack" onSubmit={(e) => void submit(e)}>
      <h3>Add by address</h3>
      <label>
        Their address
        <input
          value={to}
          onChange={(e) => setTo(e.target.value)}
          placeholder="name@server"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          required
        />
      </label>
      <label>
        A note, so they know it's you (optional)
        <input value={note} maxLength={140} onChange={(e) => setNote(e.target.value)} />
      </label>
      <button type="submit" className="primary" disabled={busy || !to.includes("@")}>
        {busy ? "Knocking…" : "Knock"}
      </button>
      <span className="hint">You can knock 10 times a day. A knock expires after 30 days.</span>
    </form>
  );
}

function Blocked({
  people,
  servers,
  onUnblock,
  onBlockServer,
}: {
  people: ConnectionView[];
  servers: { id: string; host: string }[];
  onUnblock(id: string): void;
  onBlockServer(host: string): Promise<void>;
}) {
  const [host, setHost] = useState("");
  return (
    <details className="card stack blocked">
      <summary>
        Blocked{people.length + servers.length > 0 ? ` (${people.length + servers.length})` : ""}
      </summary>
      <ul className="stack">
        {people.map((c) => (
          <li key={c.id} className="row">
            <span>{c.address}</span>
            <button type="button" onClick={() => onUnblock(c.id)}>
              Unblock
            </button>
          </li>
        ))}
        {servers.map((s) => (
          <li key={s.id} className="row">
            <span>Everyone on {s.host}</span>
            <button type="button" onClick={() => onUnblock(s.id)}>
              Unblock
            </button>
          </li>
        ))}
      </ul>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          void onBlockServer(host.trim()).then(() => setHost(""));
        }}
      >
        <input
          aria-label="Server to block"
          value={host}
          onChange={(e) => setHost(e.target.value)}
          placeholder="spam.example"
        />
        <button type="submit" className="danger" disabled={!host.trim()}>
          Block server
        </button>
      </form>
    </details>
  );
}
