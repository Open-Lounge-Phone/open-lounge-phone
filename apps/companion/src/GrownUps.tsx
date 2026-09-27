import type { User } from "./api.ts";
import type { MemberLive } from "./connection.ts";
import { presenceOf } from "./presence.ts";

interface Props {
  people: User[];
  members: Record<string, MemberLive>;
  onCall(u: User): void;
}

/** Other grown-ups on this server, with presence and an app-to-app Call button. */
export function GrownUps({ people, members, onCall }: Props) {
  if (people.length === 0) return null;
  return (
    <section className="stack" aria-labelledby="grownups-title">
      <h3 id="grownups-title">Grown-ups</h3>
      <ul className="devices">
        {people.map((u) => {
          const p = presenceOf(members[u.id]);
          return (
            <li key={u.id} className="card device">
              <div className="device-main">
                <span className={`dot ${p.dot}`} role="img" aria-label={p.label} />
                <div>
                  <div className="device-name">{u.name}</div>
                  <div className="muted small">{p.label}</div>
                </div>
              </div>
              <div className="device-actions">
                <button
                  type="button"
                  className="primary"
                  onClick={() => onCall(u)}
                  disabled={!p.callable}
                  title={p.callable ? `Call ${u.name}` : p.label}
                >
                  Call
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** "Available for calls" switch; the server persists the choice. */
export function AvailabilityToggle({
  available,
  onChange,
}: {
  available: boolean;
  onChange(v: boolean): void;
}) {
  return (
    <div className="card availability">
      <div>
        <div className="device-name">Available for calls</div>
        <div className="muted small">
          You're reachable while this app is open. Turn this off to stop calls without closing the
          app.
        </div>
      </div>
      <button
        type="button"
        role="switch"
        className="switch"
        aria-checked={available}
        aria-label="Available for calls"
        onClick={() => onChange(!available)}
      />
    </div>
  );
}
