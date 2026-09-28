import { useEffect, useState } from "react";
import type { DeviceSummary, User } from "./api.ts";
import type { DeviceLive, MemberLive } from "./connection.ts";
import { AvailabilityToggle, GrownUps } from "./GrownUps.tsx";
import { UseOldDeviceHint } from "./Pair.tsx";
import { OFFLINE_HINT, shareLink, virtualPhoneUrl } from "./phoneLed.ts";
import { formatBattery, formatLastSeen, powerWarning } from "./text.ts";

interface Props {
  devices: DeviceSummary[];
  live: Record<string, DeviceLive>;
  guardian: boolean;
  userName: string | undefined;
  onCall(d: DeviceSummary): void;
  onManage(d: DeviceSummary): void;
  onPair(): void;
  people: User[];
  members: Record<string, MemberLive>;
  onCallPerson(u: User): void;
  available: boolean;
  onAvailable(v: boolean): void;
  meId: string | undefined;
  /** Called when the user opens a new virtual phone to pair. */
  onAddingPhone(): void;
}

function useNow(intervalMs: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export function Home({
  devices,
  live,
  guardian,
  userName,
  onCall,
  onManage,
  onPair,
  people,
  members,
  onCallPerson,
  available,
  onAvailable,
  meId,
  onAddingPhone,
}: Props) {
  const now = useNow(30_000);
  const myPhone = devices.find((d) => meId && d.ownerUserId === meId);
  // Household phones (e.g. kids'); people's own phones live in their "My phone" card.
  const household = devices.filter((d) => !d.ownerUserId && d.kind !== "lounge");
  return (
    <section className="stack">
      <h2>{userName ? `Hi, ${userName}` : "Phones"}</h2>
      {meId && (
        <MyPhone
          phone={myPhone}
          live={myPhone ? live[myPhone.id] : undefined}
          meId={meId}
          userName={userName ?? "My"}
          now={now}
          onManage={onManage}
          onAdding={onAddingPhone}
        />
      )}
      <AvailabilityToggle available={available} onChange={onAvailable} />
      {(guardian || household.length > 0) && <h3>Household phones</h3>}
      {guardian && household.length === 0 && (
        <div className="card empty">
          <p>No household phones yet.</p>
          <p className="muted">Pair a phone for the family (e.g. a kid's phone).</p>
        </div>
      )}
      <ul className="devices">
        {household.map((d) => {
          const l = live[d.id];
          const online = l?.online ?? d.online;
          const canCall = !!d.contact?.canCallDevice;
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
                    {online
                      ? "Online"
                      : `Offline · last seen ${formatLastSeen(l?.lastSeen ?? d.lastSeen, now)}`}
                    {l?.battery && ` · 🔋 ${formatBattery(l.battery)}`}
                  </div>
                  {online && powerWarning(l?.power) && (
                    <div className="warning small" role="status">
                      ⚠ {powerWarning(l?.power)}
                    </div>
                  )}
                  {!online && <p className="hint offline-hint">{OFFLINE_HINT}</p>}
                </div>
              </div>
              <div className="device-actions">
                {guardian && (
                  <button type="button" onClick={() => onManage(d)}>
                    Manage
                  </button>
                )}
                <button
                  type="button"
                  className="primary"
                  onClick={() => onCall(d)}
                  disabled={!canCall}
                  title={canCall ? `Call ${d.name}` : "You're not on this phone's allow-list"}
                >
                  Call
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      <button type="button" className="add" onClick={onPair}>
        {guardian ? "+ Pair a phone" : "+ Pair my phone"}
      </button>
      <GrownUps people={people} members={members} onCall={onCallPerson} />
    </section>
  );
}

function MyPhone({
  phone,
  live,
  meId,
  userName,
  now,
  onManage,
  onAdding,
}: {
  phone: DeviceSummary | undefined;
  live: DeviceLive | undefined;
  meId: string;
  userName: string;
  now: number;
  onManage(d: DeviceSummary): void;
  onAdding(): void;
}) {
  const open = (pair: boolean) => {
    if (pair) onAdding();
    window.open(virtualPhoneUrl(meId, userName, pair), `olp-phone-${meId}`);
  };
  if (!phone) {
    return (
      <div className="card stack my-phone" id="my-phone">
        <div className="device-name">My phone</div>
        <p className="small">
          No phone yet. Set up a virtual phone — open it on your computer or an always-on tablet and
          leave it open. (The Open Lounge Phone hardware is on its way.)
        </p>
        <button type="button" className="primary" onClick={() => open(true)}>
          Add my virtual phone here
        </button>
        <OpenElsewhere meId={meId} userName={userName} />
        <UseOldDeviceHint />
      </div>
    );
  }
  const online = live?.online ?? phone.online;
  return (
    <div className="card device my-phone" id="my-phone">
      <div className="device-main">
        <span
          className={`dot ${online ? "on" : "off"}`}
          role="img"
          aria-label={online ? "online" : "offline"}
        />
        <div>
          <div className="device-name">{phone.name}</div>
          <div className="muted small">
            {online
              ? "Your phone · online"
              : `Your phone · offline · last seen ${formatLastSeen(live?.lastSeen ?? phone.lastSeen, now)}`}
            {live?.battery && ` · 🔋 ${formatBattery(live.battery)}`}
          </div>
          {!online && <p className="hint offline-hint">{OFFLINE_HINT}</p>}
        </div>
      </div>
      <div className="device-actions">
        <button type="button" onClick={() => onManage(phone)}>
          Manage
        </button>
        <button type="button" className="primary" onClick={() => open(false)}>
          Open my phone
        </button>
      </div>
      <OpenElsewhere meId={meId} userName={userName} />
    </div>
  );
}

/** Share/copy the virtual phone's link so it can live on a laptop or tablet. */
function OpenElsewhere({ meId, userName }: { meId: string; userName: string }) {
  const [note, setNote] = useState<string>();
  const url = shareLink(location.origin, meId, userName);
  const share = async () => {
    try {
      if (navigator.share) {
        await navigator.share({ title: "My Open Lounge Phone", url });
        setNote("Shared.");
        return;
      }
      await navigator.clipboard.writeText(url);
      setNote("Link copied.");
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      setNote(url);
    }
  };
  return (
    <div className="open-elsewhere">
      <button type="button" className="link" onClick={() => void share()}>
        Open on another device
      </button>
      <p className="hint">
        If you're signed in on that device it pairs itself; otherwise it shows a code — pair it here
        with “This is my own phone” ticked.
        {note && <span className="share-note"> {note}</span>}
      </p>
    </div>
  );
}
