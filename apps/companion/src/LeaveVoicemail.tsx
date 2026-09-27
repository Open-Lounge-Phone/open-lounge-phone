import { useEffect, useRef, useState } from "react";
import { type Api, ApiError } from "./api.ts";
import { MAX_RECORDING_MS, type Recording, VoicemailRecorder } from "./recording.ts";
import { formatDuration } from "./text.ts";

type Stage =
  | { name: "offer" }
  | { name: "recording"; elapsed: number }
  | { name: "review"; recording: Recording; url: string }
  | { name: "sending"; recording: Recording; url: string }
  | { name: "sent" }
  | { name: "error"; message: string; recording?: Recording; url?: string };

interface Props {
  api: Api;
  deviceId: string;
  label: string;
  onClose(): void;
}

/** Shown after a call is refused for quiet hours: record up to a minute and send it. */
export function LeaveVoicemail({ api, deviceId, label, onClose }: Props) {
  const [stage, setStage] = useState<Stage>({ name: "offer" });
  const recorder = useRef<VoicemailRecorder>(undefined);
  const urlRef = useRef<string>(undefined);

  useEffect(
    () => () => {
      recorder.current?.cancel();
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    },
    [],
  );

  useEffect(() => {
    if (stage.name !== "sent") return;
    const t = setTimeout(onClose, 2000);
    return () => clearTimeout(t);
  }, [stage.name, onClose]);

  const record = async () => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = undefined;
    setStage({ name: "recording", elapsed: 0 });
    const r = new VoicemailRecorder({
      onTick: (elapsed) => setStage({ name: "recording", elapsed }),
      onDone: (recording) => {
        const url = URL.createObjectURL(recording.blob);
        urlRef.current = url;
        setStage({ name: "review", recording, url });
      },
      onError: (message) => setStage({ name: "error", message }),
    });
    recorder.current = r;
    await r.start();
  };

  const send = async (recording: Recording, url: string) => {
    setStage({ name: "sending", recording, url });
    try {
      await api.leaveVoicemail(deviceId, recording.blob, recording.durationMs);
      setStage({ name: "sent" });
    } catch (e) {
      const message =
        e instanceof ApiError && e.status === 403
          ? "You're not on this phone's allow-list."
          : `Couldn't send: ${(e as Error).message}`;
      setStage({ name: "error", message, recording, url });
    }
  };

  return (
    <div className="voicemail-panel stack">
      {stage.name === "offer" && (
        <>
          <p>
            It's quiet hours for <strong>{label}</strong>. Leave a message? They'll get it when
            quiet hours end.
          </p>
          <div className="overlay-actions">
            <button type="button" className="round" onClick={onClose}>
              Not now
            </button>
            <button type="button" className="round accept" onClick={() => void record()}>
              Record
            </button>
          </div>
        </>
      )}
      {stage.name === "recording" && (
        <>
          <p className="recording" aria-live="polite">
            <span className="rec-dot" aria-hidden /> Recording ·{" "}
            {formatDuration(MAX_RECORDING_MS - stage.elapsed)} left
          </p>
          <progress max={MAX_RECORDING_MS} value={stage.elapsed} />
          <div className="overlay-actions">
            <button
              type="button"
              className="round decline"
              onClick={() => recorder.current?.stop()}
            >
              Stop
            </button>
          </div>
        </>
      )}
      {(stage.name === "review" || stage.name === "sending") && (
        <>
          <p>Your message ({formatDuration(stage.recording.durationMs)})</p>
          {/* biome-ignore lint/a11y/useMediaCaption: the caller's own recording */}
          <audio controls src={stage.url} />
          <div className="overlay-actions">
            <button
              type="button"
              className="round"
              disabled={stage.name === "sending"}
              onClick={() => void record()}
            >
              Re-record
            </button>
            <button
              type="button"
              className="round accept"
              disabled={stage.name === "sending"}
              onClick={() => void send(stage.recording, stage.url)}
            >
              {stage.name === "sending" ? "Sending…" : "Send"}
            </button>
          </div>
          <button type="button" className="link" onClick={onClose}>
            Discard
          </button>
        </>
      )}
      {stage.name === "sent" && <p className="ok">Message sent to {label}.</p>}
      {stage.name === "error" && (
        <>
          <p className="error" role="alert">
            {stage.message}
          </p>
          <div className="overlay-actions">
            <button type="button" className="round" onClick={onClose}>
              Close
            </button>
            {stage.recording && stage.url ? (
              <button
                type="button"
                className="round accept"
                onClick={() => void send(stage.recording as Recording, stage.url as string)}
              >
                Try again
              </button>
            ) : (
              <button type="button" className="round accept" onClick={() => void record()}>
                Try again
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
