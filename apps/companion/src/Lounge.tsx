import { type FormEvent, useCallback, useEffect, useState } from "react";
import type { Api, DeviceSummary, LoungeInfo, User } from "./api.ts";
import type { Connection, DeviceLive, MemberLive, Snapshot } from "./connection.ts";
import { guestLoungeUrl, type LoungeLink, loungeReasonText } from "./loungeLink.ts";
import { presenceOf } from "./presence.ts";

/** The page a Lounge phone's QR code opens: "Use this phone", then press the flashing key. */
export function LoungeScan({
  link,
  snap,
  conn,
  api,
  devices,
  onDone,
}: {
  link: LoungeLink;
  api: Api;
  snap: Snapshot;
  conn: Connection | undefined;
  devices: DeviceSummary[];
  onDone(): void;
}) {
  const [error, setError] = useState<string>();
  const [now, setNow] = useState(() => Date.now());
  const phone = devices.find((d) => d.id === link.deviceId);
  const live = snap.lounge?.deviceId === link.deviceId ? snap.lounge : undefined;
  const [asked, setAsked] = useState(false);
  /** A phone on another server answers over HTTP first; progress then comes over the socket. */
  const [remote, setRemote] = useState<{ step: string; reason?: string; expiresAt?: number }>();
  const claim = live ?? remote;
  const step = asked ? claim?.step : undefined;
  useEffect(() => {
    if (step !== "press_key") return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [step]);
  const name =
    phone?.name ?? (link.host ? `the Lounge phone at ${link.host}` : "this Lounge phone");

  const use = () => {
    setError(undefined);
    const host = link.host;
    if (host) {
      setAsked(true);
      setRemote({ step: "sending" });
      api.remoteLounge({ host, deviceId: link.deviceId, nonce: link.nonce }).then(
        (r) => setRemote(r),
        (e: Error) => {
          setAsked(false);
          setError(e.message);
        },
      );
      return;
    }
    // Straight from a scanned code the app may still be connecting: wait for it briefly.
    setAsked(true);
    setRemote({ step: "sending" });
    void (conn?.claimLounge(link.deviceId, link.nonce) ?? Promise.resolve(false)).then((ok) => {
      if (ok) return;
      setAsked(false);
      setRemote(undefined);
      setError("Couldn't reach the server — check your connection and try again.");
    });
  };

  return (
    <section className="stack lounge-scan">
      <h2>{name}</h2>
      {!step && (
        <div className="card stack">
          <p>
            Use <strong>{name}</strong> as yourself: it calls and is called as you, with your
            speed-dial on its keys, until you log out or leave it alone for a while. It forgets you
            afterwards.
          </p>
          <button type="button" className="primary" onClick={use}>
            Use this phone
          </button>
          <button type="button" className="link" onClick={onDone}>
            Cancel
          </button>
        </div>
      )}
      {step === "sending" && <p className="card">Asking the phone…</p>}
      {step === "press_key" && (
        <div className="card stack" role="status">
          <p className="lounge-press">Press the flashing key on the phone.</p>
          <p className="muted small">
            This proves you're at the phone.{" "}
            {claim?.expiresAt &&
              `${Math.max(0, Math.ceil((claim.expiresAt - now) / 1000))} s left.`}
          </p>
        </div>
      )}
      {step === "started" && (
        <div className="card stack" role="status">
          <p>
            You're on <strong>{name}</strong>.{" "}
            {link.host
              ? "Its keys dial your connections, through your own server."
              : "Calls to you ring there too."}
          </p>
          <div className="device-actions">
            <button
              type="button"
              onClick={() =>
                link.host
                  ? void api
                      .remoteLoungeLeave({ host: link.host, deviceId: link.deviceId })
                      .then(onDone)
                  : conn?.leaveLounge(link.deviceId)
              }
            >
              Leave
            </button>
            <button type="button" className="primary" onClick={onDone}>
              Done
            </button>
          </div>
        </div>
      )}
      {(step === "failed" || step === "ended") && (
        <div className="card stack" role="alert">
          <p>{loungeReasonText(claim?.reason)}</p>
          <button type="button" className="primary" onClick={onDone}>
            OK
          </button>
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

/** Lounge phones on Home: who is at which one (and open to chat), plus guardian settings. */
export function LoungePhones({
  api,
  devices,
  live,
  members,
  people,
  meId,
  guardian,
  conn,
  onCallPerson,
}: {
  api: Api;
  devices: DeviceSummary[];
  live: Record<string, DeviceLive>;
  members: Record<string, MemberLive>;
  people: User[];
  meId: string | undefined;
  guardian: boolean;
  conn: Connection | undefined;
  onCallPerson(u: User): void;
}) {
  const phones = devices.filter((d) => d.kind === "lounge");
  const [info, setInfo] = useState<LoungeInfo>();
  const load = useCallback(() => {
    api.lounge().then(setInfo, () => {});
  }, [api]);
  // Re-read when someone takes over or leaves a phone.
  const sessionKey = phones.map((p) => `${p.id}:${live[p.id]?.lounge?.userId ?? ""}`).join();
  useEffect(() => {
    if (sessionKey || guardian) load();
  }, [load, sessionKey, guardian]);
  if (phones.length === 0) return null;

  return (
    <section className="stack" aria-labelledby="lounge-title">
      <h3 id="lounge-title">Lounge phones</h3>
      <ul className="devices">
        {phones.map((d) => {
          const l = live[d.id];
          const online = l?.online ?? d.online;
          const who = l ? l.lounge : info?.phones.find((p) => p.id === d.id)?.session;
          const person = who ? people.find((p) => p.id === who.userId) : undefined;
          const presence = who ? presenceOf(members[who.userId]) : undefined;
          const mine = who?.userId === meId;
          const chat = who && members[who.userId]?.lounge?.openToChat;
          return (
            <li key={d.id} className="card device">
              <div className="device-main">
                <span
                  className={`dot ${online ? "on" : "off"}`}
                  role="img"
                  aria-label={online ? "online" : "offline"}
                />
                <div>
                  <div className="device-name">{d.name}</div>
                  <div className="muted small">
                    {!online
                      ? "Offline"
                      : who
                        ? `${mine ? "You're" : `${who.name} is`} here${chat ? " · open to chat" : ""}`
                        : "Free — scan its code with your phone's camera to use it"}
                  </div>
                </div>
              </div>
              <div className="device-actions">
                {who && (mine || guardian) && (
                  <button type="button" onClick={() => conn?.leaveLounge(d.id)}>
                    {mine ? "Leave" : "End session"}
                  </button>
                )}
                {who && !mine && person && (
                  <button
                    type="button"
                    className="primary"
                    disabled={!presence?.callable}
                    onClick={() => onCallPerson(person)}
                    title={presence?.label}
                  >
                    Call
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {guardian && info && (
        <LoungeSettings api={api} info={info} devices={devices} onSaved={load} />
      )}
    </section>
  );
}

function LoungeSettings({
  api,
  info,
  devices,
  onSaved,
}: {
  api: Api;
  info: LoungeInfo;
  devices: DeviceSummary[];
  onSaved(): void;
}) {
  const [minutes, setMinutes] = useState(String(info.idleMinutes));
  const [note, setNote] = useState<string>();
  const save = async () => {
    try {
      await api.setLoungeIdle(Number(minutes));
      setNote("Saved.");
      onSaved();
    } catch (e) {
      setNote((e as Error).message);
    }
  };
  const nameOf = (id: string) => devices.find((d) => d.id === id)?.name ?? "a phone";
  const history = info.history ?? [];
  return (
    <details className="card lounge-settings">
      <summary>Lounge settings and history</summary>
      <label>
        Log people out after
        <span className="inline">
          <input
            type="number"
            min={1}
            max={240}
            value={minutes}
            onChange={(e) => setMinutes(e.target.value)}
            aria-label="Idle minutes"
          />{" "}
          minutes hung up and unused
        </span>
      </label>
      <button type="button" onClick={() => void save()}>
        Save
      </button>
      {note && <span className="hint"> {note}</span>}
      <label className="check">
        <input
          type="checkbox"
          checked={info.guests ?? false}
          onChange={(e) =>
            void api
              .setLoungeGuests(e.target.checked)
              .then(onSaved, (err: Error) => setNote(err.message))
          }
        />
        <span>
          Let people from other servers use these phones
          <span className="hint">
            {" "}
            — their own server vouches for them, and they still press the flashing key.
          </span>
        </span>
      </label>
      <h4>Recent sessions</h4>
      {history.length === 0 ? (
        <p className="muted small">None yet.</p>
      ) : (
        <ul className="lounge-history small">
          {history.slice(0, 20).map((h) => (
            <li key={`${h.deviceId}-${h.startedAt}`}>
              {h.userName} on {nameOf(h.deviceId)} · {new Date(h.startedAt).toLocaleString()}
              {h.endedAt
                ? ` – ${new Date(h.endedAt).toLocaleTimeString()} (${h.endReason ?? "ended"})`
                : " · now"}
            </li>
          ))}
        </ul>
      )}
      <p className="hint">Only who used which phone and when is kept — never calls or contacts.</p>
    </details>
  );
}

/**
 * A Lounge phone's code, opened by someone without an account here: they can use it with their
 * account on another server, which vouches for them.
 */
export function GuestLounge({ link }: { link: LoungeLink }) {
  const [server, setServer] = useState("");
  const [error, setError] = useState<string>();
  const go = (e: FormEvent) => {
    e.preventDefault();
    const url = guestLoungeUrl(server, link, location.host);
    if (!url) {
      setError("Enter your address (name@server) or your server's name.");
      return;
    }
    location.assign(url);
  };
  return (
    <form className="card stack guest-lounge" onSubmit={go}>
      <h2>Use this Lounge phone</h2>
      <p className="muted">
        Have an Open Lounge Phone account on another server? Continue there: your server vouches for
        you, then you press the flashing key on the phone.
      </p>
      <label>
        Your address or server
        <input
          value={server}
          onChange={(e) => setServer(e.target.value)}
          placeholder="you@your-server"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
        />
      </label>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <button type="submit" className="primary">
        Continue on my server
      </button>
      <p className="hint">Or sign in or create an account here, below.</p>
    </form>
  );
}
