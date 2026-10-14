import { useEffect, useRef, useState } from "react";
import type { Api, ConnectionView, User } from "./api.ts";
import { canLeaveVoicemail } from "./calls.ts";
import type { Connection, Snapshot } from "./connection.ts";
import { extensionDigits, extensionProblem } from "./fields.ts";
import { LeaveVoicemail } from "./LeaveVoicemail.tsx";
import { endReasonText, formatDuration } from "./text.ts";
import { queueText } from "./workplaceText.ts";

interface Props {
  snap: Snapshot;
  conn: Connection;
  /** People in this space (for Add caller and Transfer). */
  people?: User[];
  /** For your connections (Add caller and Transfer across households and servers). */
  api?: Api;
  /** A team/org space: people and ring groups can be reached by extension too. */
  extensions?: boolean;
}

type Pick =
  | { kind: "user"; id: string; label: string }
  | { kind: "connection"; id: string; label: string }
  | { kind: "extension"; id: string; label: string };

/** Someone to add to the call or transfer it to: people here, then your connections. */
function Picker({
  people,
  api,
  title,
  onPick,
  onCancel,
  extensions,
}: {
  people: User[];
  api?: Api | undefined;
  extensions?: boolean | undefined;
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
  const [ext, setExt] = useState("");
  const [extProblem, setExtProblem] = useState<string>();
  return (
    <div className="picker stack">
      <div className="what">{title}</div>
      {extensions && (
        <form
          className="stack"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            const problem = extensionProblem(ext);
            setExtProblem(problem);
            if (!problem) onPick({ kind: "extension", id: ext, label: `Ext. ${ext}` });
          }}
        >
          <div className="row">
            <label className="row">
              <span>Extension</span>
              <input
                inputMode="numeric"
                pattern="[0-9]*"
                value={ext}
                onChange={(e) => {
                  setExt(extensionDigits(e.target.value));
                  setExtProblem(undefined);
                }}
                aria-invalid={extProblem ? true : undefined}
              />
            </label>
            <button type="submit">Go</button>
          </div>
          {extProblem && <span className="hint error">{extProblem}</span>}
        </form>
      )}
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

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"];

/** Keys for an add-on (it hears them as `call.key`, e.g. "press 1 for…"). */
function Keypad({ onKey }: { onKey(key: string): void }) {
  return (
    <fieldset className="keypad" aria-label="Keypad">
      {KEYS.map((k) => (
        <button key={k} type="button" onClick={() => onKey(k)}>
          {k}
        </button>
      ))}
    </fieldset>
  );
}

export function CallOverlay({ snap, conn, people = [], api, extensions }: Props) {
  const audio = useRef<HTMLAudioElement>(null);
  const call = snap.call;
  const held = snap.held;
  const [picking, setPicking] = useState<"add" | "transfer">();
  const [keypad, setKeypad] = useState(false);

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
      else if (p.kind === "extension") void conn.callExtension(p.id, p.label);
      else void conn.callConnection(p.id, p.label);
    } else if (picking === "transfer") {
      conn.transfer(
        p.kind === "user"
          ? { userId: p.id }
          : p.kind === "extension"
            ? { extension: p.id }
            : { connectionId: p.id },
      );
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
                extensions={extensions}
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
            <div className="who">
              {call.label}
              {call.addon && (
                <>
                  {" "}
                  <span className="badge" title="A service linked to someone's account">
                    add-on
                  </span>
                </>
              )}
            </div>
            {call.phase === "outgoing" && call.line?.description && (
              <div className="muted small">{call.line.description}</div>
            )}
            {call.phase === "incoming" && call.callback && (
              <div className="muted small">You asked to be called back. It's your turn.</div>
            )}
            {call.phase === "incoming" && call.address && (
              <div className="muted small">
                {call.address}
                {call.line ? ` · calling ${call.line}` : ""}
              </div>
            )}
            {(call.phase === "active" || call.phase === "connecting") && call.recording && (
              <div className="recording-mark" role="status">
                <span className="rec-dot" aria-hidden /> Recording · this call is recorded by{" "}
                {call.recording}
              </div>
            )}
            <div className="what">
              {call.phase === "incoming" &&
                (call.callback ? "is calling you back…" : "is calling…")}
              {call.phase === "outgoing" &&
                (call.queue ? queueText(call.queue) : call.ringing ? "Ringing…" : "Calling…")}
              {call.phase === "connecting" && "Connecting…"}
              {call.phase === "active" &&
                (call.hold === "them"
                  ? "put you on hold"
                  : formatDuration(now - (call.startedAt ?? now)))}
              {call.phase === "ended" &&
                !canLeaveVoicemail(call) &&
                (call.callbackUntil !== undefined
                  ? `${call.label} will call you back. You keep your place in line.`
                  : (call.note ?? endReasonText(call.reason, call.person)))}
            </div>
            {canLeaveVoicemail(call) && (
              <LeaveVoicemail
                offer={call.voicemail}
                label={call.label}
                onClose={() => conn.dismiss()}
              />
            )}
            {keypad && call.phase === "active" && call.addon && (
              <Keypad onKey={(k) => conn.sendKey(k)} />
            )}
            {picking === "transfer" && call.phase === "active" && (
              <Picker
                people={people}
                api={api}
                title={`Transfer ${call.label} to…`}
                onPick={pick}
                onCancel={() => setPicking(undefined)}
                extensions={extensions}
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
              {call.phase === "outgoing" && call.queue?.voicemail && (
                <button
                  type="button"
                  className="round"
                  onClick={() => conn.leaveVoicemailInstead()}
                >
                  Leave a voicemail instead
                </button>
              )}
              {call.phase === "outgoing" && call.queue?.callback && (
                <button type="button" className="round" onClick={() => conn.callMeBack()}>
                  Call me back
                </button>
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
                  {call.phase === "active" && call.addon && (
                    <button
                      type="button"
                      className={`round ${keypad ? "on" : ""}`}
                      aria-pressed={keypad}
                      onClick={() => setKeypad(!keypad)}
                    >
                      Keypad
                    </button>
                  )}
                  {call.phase === "active" && !call.addon && !held && call.hold !== "them" && (
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
