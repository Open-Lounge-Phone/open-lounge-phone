import { useEffect, useState } from "react";
import type { DeviceSummary, User } from "./api.ts";
import type { DeviceLive, MemberLive } from "./connection.ts";
import { AvailabilityToggle, GrownUps } from "./GrownUps.tsx";
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
}: Props) {
  const now = useNow(30_000);
  return (
    <section className="stack">
      <h2>{userName ? `Hi, ${userName}` : "Phones"}</h2>
      <AvailabilityToggle available={available} onChange={onAvailable} />
      <h3>Phones</h3>
      {devices.length === 0 && (
        <div className="card empty">
          <p>No phones yet.</p>
          {guardian ? (
            <p className="muted">Pair your first phone to get started.</p>
          ) : (
            <p className="muted">A guardian needs to add you to a phone.</p>
          )}
        </div>
      )}
      <ul className="devices">
        {devices.map((d) => {
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
      {guardian && (
        <button type="button" className="add" onClick={onPair}>
          + Pair a phone
        </button>
      )}
      <GrownUps people={people} members={members} onCall={onCallPerson} />
    </section>
  );
}
