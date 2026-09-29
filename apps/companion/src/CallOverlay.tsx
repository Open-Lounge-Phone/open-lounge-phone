import { useEffect, useRef, useState } from "react";
import type { Api, ConnectionView, User } from "./api.ts";
import { canLeaveVoicemail } from "./calls.ts";
import type { Connection, Snapshot } from "./connection.ts";
import { LeaveVoicemail } from "./LeaveVoicemail.tsx";
import { endReasonText, formatDuration } from "./text.ts";

interface Props {
  snap: Snapshot;
  conn: Connection;
  /** People in this space (for Add caller and Transfer). */
  people?: User[];
  /** For your connections (Add caller and Transfer across households and servers). */
  api?: Api;
}

type Pick =
  | { kind: "user"; id: string; label: string }
  | { kind: "connection"; id: string; label: string };

/** Someone to add to the call or transfer it to: people here, then your connections. */
function Picker({
  people,
  api,
  title,
  onPick,
  onCancel,
}: {
  people: User[];
  api?: Api | undefined;
  title: string;
  onPick(p: Pick): void;
  onCancel(): void;
}) {
  const [connections, setConnections] = useState<ConnectionView[]>([]);
  useEffect(() => {
    api?.connections().then(
      (c) => setConnections(c.connections.filter((x) => x.state === "active")),
      () => {},
    );
  }, [api]);
  return (
    <div className="picker stack">
      <div className="what">{title}</div>
      <ul className="devices">
        {people.map((u) => (
          <li key={u.id}>
            <button type="button" onClick={() => onPick({ kind: "user", id: u.id, label: u.name })}>
              {u.name}
            </button>
          </li>
        ))}
        {connections.map((c) => (
          <li key={c.id}>
            <button
              type="button"
              onClick={() => onPick({ kind: "connection", id: c.id, label: c.name || c.address })}
            >
              {c.name || c.address} <span className="muted small">{c.address}</span>
            </button>
          </li>
        ))}
      </ul>
      <button type="button" className="link" onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}

export function CallOverlay({ snap, conn, people = [], api }: Props) {
  const audio = useRef<HTMLAudioElement>(null);
  const call = snap.call;
  const held = snap.held;
  const [picking, setPicking] = useState<"add" | "transfer">();

  useEffect(() => {
    if (audio.current) audio.current.srcObject = snap.remote ?? null;
  }, [snap.remote]);

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (call.phase !== "active") return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [call.phase]);

  // The picker closes once the call it was for is gone.
  useEffect(() => {
    if (picking === "transfer" && call.phase !== "active") setPicking(undefined);
    if (picking === "add" && !held && call.phase === "idle") setPicking(undefined);
  }, [picking, call.phase, held]);

  const pick = (p: Pick) => {
    if (picking === "add") {
      if (p.kind === "user") void conn.callUser(p.id, p.label);
      else void conn.callConnection(p.id, p.label);
    } else if (picking === "transfer") {
      conn.transfer(p.kind === "user" ? { userId: p.id } : { connectionId: p.id });
    }
    setPicking(undefined);
  };

  const heldBar = held && (
    <div className="held-bar" role="status">
      <span>
        <strong>{held.label}</strong> is on hold
      </span>
      {call.phase === "active" && (
        <>
          <button type="button" onClick={() => conn.merge()}>
            Merge
          </button>
          <button type="button" onClick={() => conn.transferHeld()}>
            Connect them &amp; leave
          </button>
        </>
      )}
      {(call.phase === "idle" || call.phase === "ended") && (
        <button type="button" onClick={() => conn.resume()}>
          Resume
        </button>
      )}
      <button type="button" className="link" onClick={() => conn.hangupHeld()}>
        Hang up
      </button>
    </div>
  );

  return (
    <>
      {/* biome-ignore lint/a11y/useMediaCaption: live call audio has no captions */}
      <audio ref={audio} autoPlay />
      {call.phase === "idle" && held && (
        <div className="overlay overlay-held" role="dialog" aria-live="polite">
          <div className="overlay-inner stack">
            {heldBar}
            {picking === "add" ? (
              <Picker
                people={people}
                api={api}
                title="Add someone to the call"
                onPick={pick}
                onCancel={() => setPicking(undefined)}
              />
            ) : (
              <button type="button" onClick={() => setPicking("add")}>
                Call someone
              </button>
            )}
          </div>
        </div>
      )}
      {call.phase !== "idle" && (
        <div className={`overlay overlay-${call.phase}`} role="dialog" aria-live="polite">
          <div className="overlay-inner">
            {heldBar}
            <div className="avatar" aria-hidden>
              {call.label.slice(0, 1).toUpperCase()}
            </div>
            <div className="who">{call.label}</div>
            <div className="what">
              {call.phase === "incoming" && "is calling…"}
              {call.phase === "outgoing" && (call.ringing ? "Ringing…" : "Calling…")}
              {call.phase === "connecting" && "Connecting…"}
              {call.phase === "active" &&
                (call.hold === "them"
                  ? "put you on hold"
                  : formatDuration(now - (call.startedAt ?? now)))}
              {call.phase === "ended" &&
                !canLeaveVoicemail(call) &&
                (call.note ?? endReasonText(call.reason, call.person))}
            </div>
            {canLeaveVoicemail(call) && (
              <LeaveVoicemail
                offer={call.voicemail}
                label={call.label}
                onClose={() => conn.dismiss()}
              />
            )}
            {picking === "transfer" && call.phase === "active" && (
              <Picker
                people={people}
                api={api}
                title={`Transfer ${call.label} to…`}
                onPick={pick}
                onCancel={() => setPicking(undefined)}
              />
            )}
            <div className="overlay-actions">
              {call.phase === "incoming" && (
                <>
                  <button type="button" className="round decline" onClick={() => conn.decline()}>
                    Decline
                  </button>
                  <button type="button" className="round accept" onClick={() => void conn.answer()}>
                    Answer
                  </button>
                </>
              )}
              {(call.phase === "outgoing" ||
                call.phase === "connecting" ||
                call.phase === "active") && (
                <>
                  <button
                    type="button"
                    className={`round mute ${snap.muted ? "on" : ""}`}
                    aria-pressed={snap.muted}
                    onClick={() => conn.toggleMute()}
                  >
                    {snap.muted ? "Unmute" : "Mute"}
                  </button>
                  {call.phase === "active" && !held && call.hold !== "them" && (
                    <>
                      <button type="button" className="round" onClick={() => conn.hold()}>
                        Hold
                      </button>
                      <button
                        type="button"
                        className="round"
                        onClick={() => {
                          conn.hold();
                          setPicking("add");
                        }}
                      >
                        Add caller
                      </button>
                      <button
                        type="button"
                        className="round"
                        onClick={() => setPicking("transfer")}
                      >
                        Transfer
                      </button>
                    </>
                  )}
                  <button type="button" className="round decline" onClick={() => conn.hangup()}>
                    Hang up
                  </button>
                </>
              )}
              {call.phase === "ended" && !canLeaveVoicemail(call) && (
                <button type="button" className="round" onClick={() => conn.dismiss()}>
                  Close
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
