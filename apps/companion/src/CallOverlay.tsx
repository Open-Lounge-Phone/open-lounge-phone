import { useEffect, useRef, useState } from "react";
import type { Api } from "./api.ts";
import { canLeaveVoicemail } from "./calls.ts";
import type { Connection, Snapshot } from "./connection.ts";
import { LeaveVoicemail } from "./LeaveVoicemail.tsx";
import { endReasonText, formatDuration } from "./text.ts";

export function CallOverlay({ snap, conn, api }: { snap: Snapshot; conn: Connection; api: Api }) {
  const audio = useRef<HTMLAudioElement>(null);
  const call = snap.call;

  useEffect(() => {
    if (audio.current) audio.current.srcObject = snap.remote ?? null;
  }, [snap.remote]);

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (call.phase !== "active") return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [call.phase]);

  return (
    <>
      {/* biome-ignore lint/a11y/useMediaCaption: live call audio has no captions */}
      <audio ref={audio} autoPlay />
      {call.phase !== "idle" && (
        <div className={`overlay overlay-${call.phase}`} role="dialog" aria-live="polite">
          <div className="overlay-inner">
            <div className="avatar" aria-hidden>
              {call.label.slice(0, 1).toUpperCase()}
            </div>
            <div className="who">{call.label}</div>
            <div className="what">
              {call.phase === "incoming" && "is calling…"}
              {call.phase === "outgoing" && (call.ringing ? "Ringing…" : "Calling…")}
              {call.phase === "connecting" && "Connecting…"}
              {call.phase === "active" && formatDuration(now - (call.startedAt ?? now))}
              {call.phase === "ended" && endReasonText(call.reason, call.person)}
            </div>
            {canLeaveVoicemail(call) && (
              <LeaveVoicemail
                api={api}
                deviceId={call.deviceId}
                label={call.label}
                onClose={() => conn.dismiss()}
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
