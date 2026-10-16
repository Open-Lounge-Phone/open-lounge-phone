import { useEffect, useState } from "react";
import type { Api, CallBackHint, DeviceSummary, User } from "./api.ts";
import type { DeviceLive, MemberLive } from "./connection.ts";
import { AvailabilityToggle, GrownUps } from "./GrownUps.tsx";
import { MissedCalls } from "./MissedCalls.tsx";
import { Notices } from "./Notices.tsx";
import { UseOldDeviceHint } from "./Pair.tsx";
import { offlineHint, shareLink, VIRTUAL_MODEL, virtualPhoneUrl } from "./phoneLed.ts";
import { phoneLists } from "./phoneLists.ts";
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
  /** For notices to the phones (guardians), and your missed calls. */
  api?: Api;
  /** Bumped when your missed calls change. */
  missedSeq?: number;
  /** Call a missed caller back (from this space). */
  onCallBack?(hint: CallBackHint, label: string): void;
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
  api,
  missedSeq,
  onCallBack,
}: Props) {
  const now = useNow(30_000);
  // Every phone of mine (a person can have several: a desk phone, a virtual one…), household
  // phones (e.g. kids'), and other people's own phones (guardians manage those too). Lounge
  // phones have their own card.
  const { mine, household, theirs } = phoneLists(devices, meId);
  const ownerName = (id: string) => people.find((u) => u.id === id)?.name ?? "Someone";
  return (
    <section className="stack">
      <h2>{userName ? `Hi, ${userName}` : "Phones"}</h2>
      {api && onCallBack && (
        <MissedCalls api={api} {...(missedSeq ? { seq: missedSeq } : {})} onCallBack={onCallBack} />
      )}
      {meId && (
        <MyPhone
          phones={mine}
          live={live}
          householdPhones={household.length}
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
                  {!online && <p className="hint offline-hint">{offlineHint(d)}</p>}
                  {!canCall && (
                    <p className="hint">
                      This phone doesn't take your calls
                      {guardian ? ": change that under Manage." : "."}
                    </p>
                  )}
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
                  title={canCall ? `Call ${d.name}` : "This phone doesn't take your calls"}
                >
                  Call
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      {guardian && theirs.length > 0 && (
        <>
          <h3>People's own phones</h3>
          <ul className="devices">
            {theirs.map((d) => {
              const l = live[d.id];
              const online = l?.online ?? d.online;
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
                        {ownerName(d.ownerUserId as string)}'s phone ·{" "}
                        {online
                          ? "online"
                          : `offline · last seen ${formatLastSeen(l?.lastSeen ?? d.lastSeen, now)}`}
                      </div>
                    </div>
                  </div>
                  <div className="device-actions">
                    <button type="button" onClick={() => onManage(d)}>
                      Manage
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
      <button type="button" className="add" onClick={onPair}>
        {guardian ? "+ Pair a phone" : "+ Pair my phone"}
      </button>
      {guardian && api && devices.length > 0 && <Notices api={api} devices={devices} />}
      <GrownUps people={people} members={members} onCall={onCallPerson} />
    </section>
  );
}

function MyPhone({
  phones,
  live,
  householdPhones,
  meId,
  userName,
  now,
  onManage,
  onAdding,
}: {
  /** Every phone of mine here: desk phones and the virtual one. */
  phones: DeviceSummary[];
  live: Record<string, DeviceLive>;
  /** Phones here that belong to the household, not to anyone: none of them is "my" phone. */
  householdPhones: number;
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
  if (phones.length === 0) {
    return (
      <div className="card stack my-phone" id="my-phone">
        <div className="device-name">My phone</div>
        <p className="small">
          {householdPhones > 0
            ? "None of the phones here is set up as yours: the ones below belong to the household. To make one of them your own phone, remove it and pair it again as “My own phone”. Or set up a virtual phone:"
            : "You don't have your own phone here yet. Pair an Open Lounge Phone as “My own phone”, or set up a virtual phone: open it on your computer or an always-on tablet and leave it open."}
        </p>
        <button type="button" className="primary" onClick={() => open(true)}>
          Add my virtual phone here
        </button>
        <OpenElsewhere meId={meId} userName={userName} />
        <UseOldDeviceHint />
      </div>
    );
  }
  const hasVirtual = phones.some(isVirtual);
  return (
    <div className="card stack my-phone" id="my-phone">
      <div className="device-name">{phones.length > 1 ? "My phones" : "My phone"}</div>
      <ul className="devices">
        {phones.map((phone) => {
          const l = live[phone.id];
          const online = l?.online ?? phone.online;
          return (
            <li key={phone.id} className="device">
              <div className="device-main">
                <span
                  className={`dot ${online ? "on" : "off"}`}
                  role="img"
                  aria-label={online ? "online" : "offline"}
                />
                <div>
                  <div className="device-name">{phone.name}</div>
                  <div className="muted small">
                    {isVirtual(phone) ? "Virtual phone" : "Your phone"} ·{" "}
                    {online
                      ? "online"
                      : `offline · last seen ${formatLastSeen(l?.lastSeen ?? phone.lastSeen, now)}`}
                    {l?.battery && ` · 🔋 ${formatBattery(l.battery)}`}
                  </div>
                  {!online && <p className="hint offline-hint">{offlineHint(phone)}</p>}
                </div>
              </div>
              <div className="device-actions">
                <button type="button" onClick={() => onManage(phone)}>
                  Manage
                </button>
                {isVirtual(phone) && (
                  <button type="button" className="primary" onClick={() => open(false)}>
                    Open my phone
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {!hasVirtual && (
        <button type="button" className="link" onClick={() => open(true)}>
          Add a virtual phone too
        </button>
      )}
      <OpenElsewhere meId={meId} userName={userName} />
    </div>
  );
}

function isVirtual(d: DeviceSummary): boolean {
  return d.model === VIRTUAL_MODEL;
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
        as “My own phone”.
        {note && <span className="share-note"> {note}</span>}
      </p>
    </div>
  );
}
