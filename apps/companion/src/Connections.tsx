import { type FormEvent, useCallback, useEffect, useState } from "react";
import { renderSVG } from "uqr";
import { heldShareLabel } from "./addonText.ts";
import type { Api, ConnectionsInfo, ConnectionView, Retention } from "./api.ts";
import { daysLeft, groupConnections, hostBadge } from "./connectionGroups.ts";
import { addressProblem, serverName, serverProblem } from "./fields.ts";
import { BuddyTimeline } from "./Timeline.tsx";
import { listNames } from "./text.ts";
import { retentionOptions } from "./timelineText.ts";

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
  /** Call a business's public line by its address (no knock needed). */
  onCallLine?: ((address: string) => void) | undefined;
  /** Call an add-on (yours) or a share of one (given to you) by its address. */
  onCallAddon?: ((address: string, label: string) => void) | undefined;
  /** Opens the Add-ons tab. */
  onAddons?: (() => void) | undefined;
}

/**
 * Connections: grown-ups you can reach, on this server or others. Knock on an address, answer
 * knocks, and block people or whole servers. Kids' phones are never knockable; a guardian can
 * put a connection on a phone's allow-list from the phone's page.
 */
export function Connections({
  api,
  refreshKey,
  onBack,
  onRequests,
  onCall,
  onCallPhone,
  onCallLine,
  onCallAddon,
  onAddons,
}: Props) {
  const [info, setInfo] = useState<ConnectionsInfo>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [showQr, setShowQr] = useState(false);
  const [open, setOpen] = useState<string>();
  const [retention, setRetention] = useState<Retention>();
  /** What "Space default" means here (the active space's history setting). */
  const [spaceDefault, setSpaceDefault] = useState<"30d" | "1y" | "forever">("forever");
  /** Whether there's anything under Add-ons to point at. */
  const [addons, setAddons] = useState(false);
  const withAddons = onAddons !== undefined;

  const load = useCallback(async () => {
    try {
      const next = await api.connections();
      setInfo(next);
      setRetention((await api.accountRetention()).retention);
      setSpaceDefault((await api.spacePrivacy().catch(() => undefined))?.history ?? "forever");
      if (withAddons) {
        const [mine, shared] = await Promise.all([
          api.addons().catch(() => undefined),
          api.addonsShared().catch(() => undefined),
        ]);
        setAddons(!!mine?.addons.length || !!shared?.held.length);
      }
      onRequests(groupConnections(next.connections).requests.length);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [api, onRequests, withAddons]);

  useEffect(() => {
    void refreshKey;
    void load();
  }, [load, refreshKey]);

  const run = async (fn: () => Promise<unknown>, done?: string) => {
    const problem = await attempt(fn, done);
    if (problem) setError(problem);
  };
  /** Like `run`, for a form: returns what went wrong, so the form shows it next to itself. */
  const attempt = async (fn: () => Promise<unknown>, done?: string) => {
    setError(undefined);
    setNotice(undefined);
    let problem: string | undefined;
    try {
      await fn();
      if (done) setNotice(done);
    } catch (e) {
      problem = (e as Error).message;
    }
    await load();
    return problem;
  };

  const groups = groupConnections(info?.connections ?? []);
  const now = Date.now();

  const opened = info?.connections.find((c) => c.id === open);
  if (open) {
    return (
      <BuddyTimeline
        api={api}
        connectionId={open}
        refreshKey={refreshKey}
        onBack={() => setOpen(undefined)}
        onCall={opened && onCall ? () => onCall(opened) : undefined}
      />
    );
  }

  return (
    <section className="stack connections">
      <button type="button" className="link back" onClick={onBack}>
        ← Back
      </button>
      <h2>Connections (buddies)</h2>
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
          {retention && (
            <label>
              Keep history with connections
              <select
                value={retention}
                onChange={(e) =>
                  void run(() => api.setAccountRetention(e.target.value as Retention))
                }
              >
                {retentionOptions(spaceDefault, "Space default").map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              <span className="hint">
                Calls and voicemails older than this are deleted, audio included. Each connection
                can have its own setting (open its history).
              </span>
            </label>
          )}
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
          attempt(async () => {
            const r = await api.knock(to, note);
            if (r.status === "connected") setNotice(`You're connected with ${to}.`);
            else setNotice(`If ${to} exists, they'll get your request.`);
          })
        }
      />
      {onCallLine && <CallLineForm onCall={onCallLine} />}
      {onAddons && addons && (
        <div className="card row wrap">
          <span className="grow">
            Your add-ons, and the ones shared with you, are under Add-ons.
          </span>
          <button type="button" onClick={onAddons}>
            Add-ons
          </button>
        </div>
      )}

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
                  <button type="button" onClick={() => setOpen(c.id)}>
                    History
                  </button>
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
              {(c.yourPhones ?? []).length > 0 && (
                <p className="small muted your-phones">
                  Can call your {listNames((c.yourPhones ?? []).map((p) => p.label))}. Change that
                  on the phone's page.
                </p>
              )}
              {(c.addonShares ?? []).length > 0 && (
                <ul className="shared-phones">
                  {(c.addonShares ?? []).map((x) => (
                    <li key={x.address} className="row">
                      <span>
                        {heldShareLabel(c.name || c.address, x.addon, x.label)}{" "}
                        <span className="badge">add-on</span>
                      </span>
                      {onCallAddon && (
                        <button
                          type="button"
                          onClick={() => onCallAddon(x.address, `${x.addon} · ${x.label}`)}
                        >
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
        onBlockServer={(host) =>
          attempt(() => api.blockServer(host), `Blocked everyone on ${host}.`)
        }
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

/** A business's public line: call it by its address, without knocking first. */
function CallLineForm({ onCall }: { onCall(address: string): void }) {
  const [to, setTo] = useState("");
  const [problem, setProblem] = useState<string>();
  return (
    <form
      className="card stack"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        const p = addressProblem(to);
        setProblem(p);
        if (!p) onCall(to.trim().toLowerCase());
      }}
    >
      <h3>Call a public line</h3>
      <label>
        The line's address
        <input
          value={to}
          onChange={(e) => {
            setTo(e.target.value);
            setProblem(undefined);
          }}
          inputMode="email"
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          aria-invalid={problem ? true : undefined}
        />
        <span className={problem ? "hint error" : "hint"}>
          {problem ?? "Like name@server, for example support@example.org."}
        </span>
      </label>
      <button type="submit" className="primary">
        Call
      </button>
      <span className="hint">
        Businesses can publish a line anyone may call. They see your address when you call.
      </span>
    </form>
  );
}

function KnockForm({
  onKnock,
}: {
  /** Resolves with what went wrong, if anything. */
  onKnock(to: string, note?: string): Promise<string | undefined>;
}) {
  const [to, setTo] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const [failed, setFailed] = useState<string>();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const p = addressProblem(to);
    setProblem(p);
    setFailed(undefined);
    if (p) return;
    setBusy(true);
    const error = await onKnock(to.trim().toLowerCase(), note.trim() || undefined);
    setBusy(false);
    if (error) return setFailed(error);
    setTo("");
    setNote("");
  };
  return (
    <form className="card stack" noValidate onSubmit={(e) => void submit(e)}>
      <h3>Add by address</h3>
      <label>
        Their address
        <input
          value={to}
          onChange={(e) => {
            setTo(e.target.value);
            setProblem(undefined);
          }}
          inputMode="email"
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          aria-invalid={problem ? true : undefined}
        />
        <span className={problem ? "hint error" : "hint"}>
          {problem ?? "Like name@server: they'll find theirs on their Connections page."}
        </span>
      </label>
      <label>
        A note, so they know it's you (optional)
        <input value={note} maxLength={140} onChange={(e) => setNote(e.target.value)} />
      </label>
      {failed && (
        <p className="error" role="alert">
          {failed}
        </p>
      )}
      <button type="submit" className="primary" disabled={busy}>
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
  /** Resolves with what went wrong, if anything. */
  onBlockServer(host: string): Promise<string | undefined>;
}) {
  const [host, setHost] = useState("");
  const [problem, setProblem] = useState<string>();
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
        className="stack"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          const p = serverProblem(host);
          setProblem(p);
          if (p) return;
          void onBlockServer(serverName(host)).then((error) => {
            setProblem(error);
            if (!error) setHost("");
          });
        }}
      >
        <label>
          Block everyone on a server
          <input
            value={host}
            onChange={(e) => {
              setHost(e.target.value);
              setProblem(undefined);
            }}
            inputMode="url"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            aria-invalid={problem ? true : undefined}
          />
          <span className={problem ? "hint error" : "hint"}>
            {problem ?? "The server's name, like example.org."}
          </span>
        </label>
        <button type="submit" className="danger">
          Block server
        </button>
      </form>
    </details>
  );
}
