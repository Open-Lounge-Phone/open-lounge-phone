import { useCallback, useEffect, useState } from "react";
import type { Api, DeviceSummary, LoungeInfo, User } from "./api.ts";
import type { Connection, DeviceLive, MemberLive, Snapshot } from "./connection.ts";
import { type LoungeLink, loungeReasonText } from "./loungeLink.ts";
import { presenceOf } from "./presence.ts";

/** The page a Lounge phone's QR code opens: "Use this phone", then press the flashing key. */
export function LoungeScan({
  link,
  snap,
  conn,
  devices,
  onDone,
}: {
  link: LoungeLink;
  snap: Snapshot;
  conn: Connection | undefined;
  devices: DeviceSummary[];
  onDone(): void;
}) {
  const [error, setError] = useState<string>();
  const [now, setNow] = useState(() => Date.now());
  const phone = devices.find((d) => d.id === link.deviceId);
  const claim = snap.lounge?.deviceId === link.deviceId ? snap.lounge : undefined;
  const [asked, setAsked] = useState(false);
  const step = asked ? claim?.step : undefined;
  useEffect(() => {
    if (step !== "press_key") return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [step]);
  const name = phone?.name ?? "this Lounge phone";

  const use = () => {
    setError(undefined);
    if (!conn?.claimLounge(link.deviceId, link.nonce)) {
      setError("Not connected to the server — try again in a moment.");
      return;
    }
    setAsked(true);
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
            You're on <strong>{name}</strong>. Calls to you ring there too.
          </p>
          <div className="device-actions">
            <button type="button" onClick={() => conn?.leaveLounge(link.deviceId)}>
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
