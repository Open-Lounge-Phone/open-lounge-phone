import { type FormEvent, useCallback, useEffect, useState } from "react";
import type {
  Api,
  DeviceSummary,
  HouseLineKey,
  HouseLineTarget,
  LoungeIdle,
  LoungeInfo,
  LoungeSessionPolicy,
  User,
} from "./api.ts";
import type { Connection, DeviceLive, MemberLive, Snapshot } from "./connection.ts";
import {
  HOUSE_LINE_DIGITS,
  incompleteKeys,
  indexOfDigit,
  parseTarget,
  setKey,
  targetValue,
} from "./houseLine.ts";
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
        <LoungeSettings api={api} info={info} devices={devices} people={people} onSaved={load} />
      )}
    </section>
  );
}

function LoungeSettings({
  api,
  info,
  devices,
  people,
  onSaved,
}: {
  api: Api;
  info: LoungeInfo;
  devices: DeviceSummary[];
  people: User[];
  onSaved(): void;
}) {
  const [minutes, setMinutes] = useState(String(info.idleMinutes));
  const [policy, setPolicy] = useState<LoungeSessionPolicy>(info.session ?? "idle");
  const [dayEnd, setDayEnd] = useState(info.dayEnd ?? "00:00");
  const [note, setNote] = useState<string>();
  const save = async () => {
    try {
      await api.setLoungeSettings({
        session: policy,
        ...(policy === "idle" ? { idleMinutes: Number(minutes) } : {}),
        ...(policy === "end_of_day" ? { dayEnd } : {}),
      });
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
        Sessions last
        <select
          value={policy}
          onChange={(e) => setPolicy(e.target.value as LoungeSessionPolicy)}
          aria-label="Session length"
        >
          <option value="idle">Until the phone sits unused (a venue)</option>
          <option value="end_of_day">Until the end of the day (hot desks)</option>
          <option value="until_logout">Until the person logs out (an office desk)</option>
        </select>
      </label>
      {policy === "idle" && (
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
      )}
      {policy === "end_of_day" && (
        <label>
          The day ends at
          <input
            type="time"
            value={dayEnd}
            onChange={(e) => setDayEnd(e.target.value)}
            aria-label="End of day"
          />
        </label>
      )}
      <span className="hint">
        Sessions also end on Log out, Leave, a new sign-in, or if the phone is offline for a minute.
      </span>
      <button type="button" onClick={() => void save()}>
        Save
      </button>
      {note && <span className="hint"> {note}</span>}
      {info.idle && (
        <IdleOptions
          api={api}
          idle={info.idle}
          people={people}
          desks={devices.filter((d) => d.mode === "personal")}
          onSaved={onSaved}
          onError={setNote}
        />
      )}
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

/**
 * What a Lounge phone offers while nobody is signed in — all off by default: house-line keys
 * (they call as the space: a person, someone's desk phone, or a group where the first to answer
 * takes it) and "who's here" (people open to chat at the other Lounge phones).
 */
function IdleOptions({
  api,
  idle,
  people,
  desks,
  onSaved,
  onError,
}: {
  api: Api;
  idle: LoungeIdle;
  people: User[];
  desks: DeviceSummary[];
  onSaved(): void;
  onError(message: string): void;
}) {
  const [enabled, setEnabled] = useState(idle.houseLine.enabled);
  const [keys, setKeys] = useState<HouseLineKey[]>(idle.houseLine.keys);
  const unfinished = incompleteKeys(keys);
  const save = (patch: Parameters<Api["setLoungeSettings"]>[0]) =>
    api.setLoungeSettings(patch).then(onSaved, (e: Error) => onError(e.message));
  return (
    <div className="stack idle-options">
      <h4>When nobody is signed in</h4>
      <p className="hint">
        A Lounge phone is dead until someone signs in, unless you turn these on.
      </p>
      <label className="check">
        <input
          type="checkbox"
          checked={idle.whosHere}
          onChange={(e) => void save({ whosHere: e.target.checked })}
        />
        <span>
          Who's here
          <span className="hint">
            {" "}
            — show people signed in at the other Lounge phones who are open to chat.
          </span>
        </span>
      </label>
      <label className="check">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        <span>
          House-line keys
          <span className="hint"> — keys that call as this space, e.g. the front desk.</span>
        </span>
      </label>
      {enabled && (
        <ul className="stack house-line">
          {HOUSE_LINE_DIGITS.map((digit) => {
            const index = indexOfDigit(digit);
            const key = keys.find((k) => k.index === index);
            const group = key?.target.kind === "group" ? key.target.userIds : [];
            const update = (label: string, target: HouseLineTarget | undefined) =>
              setKeys((ks) => setKey(ks, index, target ? { label, target } : undefined));
            return (
              <li key={digit} className="stack">
                <div className="row">
                  <span className="key-digit">{digit}</span>
                  <select
                    aria-label={`Key ${digit} calls`}
                    value={targetValue(key?.target)}
                    onChange={(e) => {
                      const target = parseTarget(e.target.value);
                      const who =
                        target?.kind === "user"
                          ? people.find((p) => p.id === target.userId)?.name
                          : target?.kind === "device"
                            ? desks.find((d) => d.id === target.deviceId)?.name
                            : undefined;
                      update(key?.label || who || "", target);
                    }}
                  >
                    <option value="">— nothing —</option>
                    {people.map((p) => (
                      <option key={p.id} value={`user:${p.id}`}>
                        {p.name}
                      </option>
                    ))}
                    {desks.map((d) => (
                      <option key={d.id} value={`device:${d.id}`}>
                        {d.name} (desk phone)
                      </option>
                    ))}
                    <option value="group">Several people…</option>
                  </select>
                  {key && (
                    <input
                      aria-label={`Key ${digit} label`}
                      value={key.label}
                      maxLength={24}
                      placeholder="Label"
                      onChange={(e) => update(e.target.value, key.target)}
                    />
                  )}
                </div>
                {key?.target.kind === "group" && (
                  <div className="row wrap">
                    {people.map((p) => (
                      <label key={p.id} className="check small">
                        <input
                          type="checkbox"
                          checked={group.includes(p.id)}
                          onChange={(e) =>
                            update(key.label, {
                              kind: "group",
                              userIds: e.target.checked
                                ? [...group, p.id]
                                : group.filter((u) => u !== p.id),
                            })
                          }
                        />
                        <span>{p.name}</span>
                      </label>
                    ))}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {(enabled || idle.houseLine.enabled) && (
        <button
          type="button"
          disabled={unfinished.length > 0}
          onClick={() => void save({ houseLine: { enabled, keys } })}
        >
          Save house-line keys
        </button>
      )}
      {unfinished.length > 0 && (
        <span className="hint">Give every key a label, and pick people for each group.</span>
      )}
    </div>
  );
}
