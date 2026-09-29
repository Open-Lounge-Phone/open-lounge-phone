import { browserVoice, LeaveMessage, type LeaveState } from "@openloungephone/client";
import type { VoicemailOffer } from "@openloungephone/protocol";
import { useEffect, useRef, useState } from "react";
import { formatDuration } from "./text.ts";

interface Props {
  offer: VoicemailOffer;
  label: string;
  onClose(): void;
}

/**
 * After an unanswered call: their greeting plays, then the tone, then you talk. Hang up to send
 * (up to two minutes). Works the same for a person, a kids' phone, or someone on another server.
 */
export function LeaveVoicemail({ offer, label, onClose }: Props) {
  const [state, setState] = useState<LeaveState>({ stage: "greeting" });
  const flow = useRef<LeaveMessage>(undefined);

  useEffect(() => {
    const f = new LeaveMessage({ offer, voice: browserVoice(), onState: setState });
    flow.current = f;
    void f.start();
    return () => f.cancel();
  }, [offer]);

  useEffect(() => {
    if (state.stage !== "sent" && state.stage !== "cancelled") return;
    const t = setTimeout(onClose, state.stage === "sent" ? 2000 : 0);
    return () => clearTimeout(t);
  }, [state.stage, onClose]);

  return (
    <div className="voicemail-panel stack">
      {state.stage === "greeting" && (
        <>
          <p aria-live="polite">
            <strong>{label}</strong> can't take your call — listen for the tone to leave a message.
          </p>
          <div className="overlay-actions">
            <button type="button" className="round" onClick={() => flow.current?.cancel()}>
              Not now
            </button>
          </div>
        </>
      )}
      {state.stage === "recording" && (
        <>
          <p className="recording" aria-live="polite">
            <span className="rec-dot" aria-hidden /> Recording ·{" "}
            {formatDuration(state.maxMs - state.elapsed)} left
          </p>
          <progress max={state.maxMs} value={state.elapsed} />
          <div className="overlay-actions">
            <button type="button" className="round" onClick={() => flow.current?.cancel()}>
              Discard
            </button>
            <button type="button" className="round decline" onClick={() => flow.current?.finish()}>
              Hang up & send
            </button>
          </div>
        </>
      )}
      {state.stage === "sending" && <p aria-live="polite">Sending…</p>}
      {state.stage === "sent" && <p className="ok">Message sent to {label}.</p>}
      {state.stage === "failed" && (
        <>
          <p className="error" role="alert">
            Your message wasn't sent: {state.message}
          </p>
          <div className="overlay-actions">
            <button type="button" className="round" onClick={onClose}>
              Close
            </button>
            {state.canRetry && (
              <button type="button" className="round accept" onClick={() => flow.current?.retry()}>
                Try again
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
