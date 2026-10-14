// A ring group's public line (team and org admins): its address, the warning before it goes
// public, who may call, the queue, voicemail and its greeting, limits, recent callers and the
// space's blocklist. See docs/workplace.md "Public lines".
import { useCallback, useEffect, useRef, useState } from "react";
import type { Api, Directory, LineCaller, LinePatch, LineSettings, RingGroupInfo } from "./api.ts";
import { VoicemailRecorder } from "./recording.ts";
import { maxWaitText, WHO_TEXT } from "./workplaceText.ts";

type Blocks = Awaited<ReturnType<Api["lineBlocks"]>>;

export function PublicLineEditor({
  api,
  group,
  dir,
}: {
  api: Api;
  group: RingGroupInfo;
  dir: Directory;
}) {
  const [line, setLine] = useState<LineSettings | null>();
  const [warning, setWarning] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [callers, setCallers] = useState<LineCaller[]>([]);
  const [blocks, setBlocks] = useState<Blocks>([]);
  const [handle, setHandle] = useState("");
  const [error, setError] = useState<string>();
  const [recording, setRecording] = useState(false);
  const recorder = useRef<VoicemailRecorder>(undefined);

  const load = useCallback(async () => {
    try {
      const r = await api.line(group.id);
      setLine(r.line);
      setWarning(r.warning);
      if (r.line) {
        const [c, b] = await Promise.all([api.lineCallers(group.id), api.lineBlocks()]);
        setCallers(c);
        setBlocks(b);
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }, [api, group.id]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => () => recorder.current?.cancel(), []);

  const act = async (fn: () => Promise<unknown>) => {
    setError(undefined);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    }
    await load();
  };
  const save = (patch: LinePatch) => act(() => api.setLine(group.id, patch));

  const recordGreeting = async () => {
    setRecording(true);
    const r = new VoicemailRecorder(
      {
        onTick: () => {},
        onDone: (rec) => {
          setRecording(false);
          void act(() => api.setLineGreeting(group.id, "custom", rec.blob, rec.durationMs));
        },
        onError: (message) => {
          setRecording(false);
          setError(message);
        },
      },
      30_000,
    );
    recorder.current = r;
    await r.start();
  };

  if (line === undefined) return error ? <p className="error">{error}</p> : null;

  if (line === null) {
    return (
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void save({ handle: handle.trim().toLowerCase() });
        }}
      >
        <h4>Public line</h4>
        <p className="muted small">
          Give this group its own address, like help-desk@this-server, so people on any server can
          call it without connecting first. It stays off until you turn it on.
        </p>
        <div className="row">
          <input
            aria-label="Line address"
            placeholder="help-desk"
            value={handle}
            autoCapitalize="none"
            onChange={(e) => setHandle(e.target.value)}
          />
          <button type="submit" disabled={handle.trim().length < 2}>
            Choose address
          </button>
        </div>
        {error && <p className="error">{error}</p>}
      </form>
    );
  }

  const wait = line.atMaxWait;
  const encodeWait = () =>
    wait.kind === "group"
      ? `g:${wait.groupId}`
      : wait.kind === "user"
        ? `u:${wait.userId}`
        : wait.kind;
  const decodeWait = (v: string): LineSettings["atMaxWait"] =>
    v.startsWith("g:")
      ? { kind: "group", groupId: v.slice(2) }
      : v.startsWith("u:")
        ? { kind: "user", userId: v.slice(2) }
        : v === "end"
          ? { kind: "end" }
          : { kind: "voicemail" };
  const perHour = (v: string) => (v.trim() === "" ? null : Math.max(1, Number(v) || 1));
  const ownServer = line.address.slice(line.address.lastIndexOf("@") + 1);
  const blockedBy = (c: LineCaller) =>
    blocks.some((b) => b.kind === "server" && b.value === c.server)
      ? "Server blocked"
      : blocks.some((b) => b.kind === "address" && b.value === c.address.toLowerCase())
        ? "Blocked"
        : undefined;

  return (
    <div className="stack">
      <h4>Public line · {line.address}</h4>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <label className="row">
        <input
          type="checkbox"
          checked={line.enabled}
          onChange={(e) => (e.target.checked ? setConfirming(true) : void save({ enabled: false }))}
        />
        <span>{line.enabled ? "Public: anyone allowed below can call it" : "Off"}</span>
      </label>
      {confirming && (
        <div className="card stack warning" role="alertdialog" aria-label="Make this line public?">
          <strong>Make this line public?</strong>
          <p>{warning}</p>
          <div className="row">
            <button
              type="button"
              className="primary"
              onClick={() => {
                setConfirming(false);
                void save({ enabled: true, confirm: true });
              }}
            >
              Make it public
            </button>
            <button type="button" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      <label className="stack">
        <span className="muted small">Name callers see</span>
        <input
          defaultValue={line.displayName ?? ""}
          placeholder={group.name}
          maxLength={64}
          onBlur={(e) =>
            e.target.value.trim() !== (line.displayName ?? "") &&
            void save({ displayName: e.target.value.trim() || null })
          }
        />
      </label>
      <label className="stack">
        <span className="muted small">One line about it (optional)</span>
        <input
          defaultValue={line.description ?? ""}
          placeholder="Questions about your order"
          maxLength={140}
          onBlur={(e) =>
            e.target.value.trim() !== (line.description ?? "") &&
            void save({ description: e.target.value.trim() || null })
          }
        />
      </label>

      <label className="stack">
        <span className="muted small">Who can call</span>
        <select
          value={line.who}
          onChange={(e) => void save({ who: e.target.value as LineSettings["who"] })}
        >
          {Object.entries(WHO_TEXT).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <span className="muted small">Kids' phones can never call a public line.</span>
      </label>
      {line.who === "allowlist" && (
        <label className="stack">
          <span className="muted small">Servers or addresses, one per line</span>
          <textarea
            defaultValue={line.allow.join("\n")}
            rows={3}
            placeholder={"partner.example\nann@far.example"}
            onBlur={(e) =>
              void save({
                allow: e.target.value
                  .split(/\s+/)
                  .map((x) => x.trim())
                  .filter(Boolean),
              })
            }
          />
        </label>
      )}

      <fieldset className="stack">
        <legend className="muted small">When nobody is free</legend>
        <label className="row">
          <input
            type="checkbox"
            checked={line.queue}
            onChange={(e) => void save({ queue: e.target.checked })}
          />
          <span>Callers wait in line</span>
        </label>
        {line.queue && (
          <>
            <label className="row">
              <span>At most</span>
              <input
                type="number"
                min={1}
                max={50}
                defaultValue={line.queueMax}
                onBlur={(e) => void save({ queueMax: Number(e.target.value) })}
              />
              <span>callers waiting</span>
            </label>
            <label className="row">
              <span>For at most</span>
              <input
                type="number"
                min={1}
                max={60}
                defaultValue={Math.round(line.queueWaitSeconds / 60)}
                onBlur={(e) => void save({ queueWaitSeconds: Number(e.target.value) * 60 })}
              />
              <span>minutes, then</span>
              <select
                aria-label="At the longest wait"
                value={encodeWait()}
                onChange={(e) => void save({ atMaxWait: decodeWait(e.target.value) })}
              >
                <option value="voicemail">{maxWaitText({ kind: "voicemail" }, dir)}</option>
                {dir.groups
                  .filter((g) => g.id !== group.id)
                  .map((g) => (
                    <option key={g.id} value={`g:${g.id}`}>
                      Forward to {g.name}
                    </option>
                  ))}
                {dir.members.map((m) => (
                  <option key={m.id} value={`u:${m.id}`}>
                    Forward to {m.name}
                  </option>
                ))}
                <option value="end">{maxWaitText({ kind: "end" }, dir)}</option>
              </select>
            </label>
            {wait.kind === "end" && (
              <input
                aria-label="What callers hear when the call ends"
                placeholder="Nobody could take your call. Please try again later."
                maxLength={140}
                defaultValue={wait.message ?? ""}
                onBlur={(e) =>
                  void save({
                    atMaxWait: e.target.value.trim()
                      ? { kind: "end", message: e.target.value.trim() }
                      : { kind: "end" },
                  })
                }
              />
            )}
            <label className="row">
              <input
                type="checkbox"
                checked={line.showPosition}
                onChange={(e) => void save({ showPosition: e.target.checked })}
              />
              <span>Show callers their place in line</span>
            </label>
            <label className="row">
              <input
                type="checkbox"
                checked={line.offerVoicemail}
                disabled={!line.voicemail}
                onChange={(e) => void save({ offerVoicemail: e.target.checked })}
              />
              <span>Offer "Leave a voicemail instead" while they wait</span>
            </label>
          </>
        )}
      </fieldset>

      <fieldset className="stack">
        <legend className="muted small">Voicemail</legend>
        <label className="row">
          <input
            type="checkbox"
            checked={line.voicemail}
            onChange={(e) => void save({ voicemail: e.target.checked })}
          />
          <span>Callers can leave a message in {group.name}'s shared box</span>
        </label>
        {line.voicemail && (
          <div className="row wrap">
            <span className="muted small">
              Greeting: {line.greeting === "default" ? "the standard one" : "your recording"}
            </span>
            {recording ? (
              <button type="button" className="primary" onClick={() => recorder.current?.stop()}>
                Stop recording
              </button>
            ) : (
              <button type="button" onClick={() => void recordGreeting()}>
                Record a greeting (30 s)
              </button>
            )}
            {line.greeting !== "default" && (
              <button type="button" onClick={() => void act(() => api.resetLineGreeting(group.id))}>
                Use the standard greeting
              </button>
            )}
          </div>
        )}
      </fieldset>

      <fieldset className="row wrap">
        <legend className="muted small">Limits (calls per hour)</legend>
        <label className="row">
          <span>Each caller</span>
          <input
            type="number"
            min={1}
            max={line.limits.callerPerHour}
            placeholder={String(line.limits.callerPerHour)}
            defaultValue={line.callerPerHour ?? ""}
            onBlur={(e) => void save({ callerPerHour: perHour(e.target.value) })}
          />
        </label>
        <label className="row">
          <span>Each other server</span>
          <input
            type="number"
            min={1}
            max={line.limits.serverPerHour}
            placeholder={String(line.limits.serverPerHour)}
            defaultValue={line.serverPerHour ?? ""}
            onBlur={(e) => void save({ serverPerHour: perHour(e.target.value) })}
          />
        </label>
      </fieldset>

      <h4>Recent callers</h4>
      <ul className="stack">
        {callers.map((c) => (
          <li key={`${c.address}-${c.at}`} className="row wrap small">
            <span className="grow">
              {new Date(c.at).toLocaleString()} · {c.name}{" "}
              <span className="muted">
                {c.address} · {c.outcome}
              </span>
            </span>
            {blockedBy(c) ? (
              <span className="muted small">{blockedBy(c)}</span>
            ) : (
              <>
                <button
                  type="button"
                  className="link"
                  onClick={() => void act(() => api.blockForLines(c.address))}
                >
                  Block person
                </button>
                {/* Blocking this server would shut out everyone here, the line's own people too. */}
                {c.server !== ownServer && (
                  <button
                    type="button"
                    className="link"
                    onClick={() => void act(() => api.blockForLines(c.server))}
                  >
                    Block server
                  </button>
                )}
              </>
            )}
          </li>
        ))}
        {callers.length === 0 && <li className="muted small">No calls yet.</li>}
      </ul>
      {blocks.length > 0 && (
        <>
          <h4>Blocked from your public lines</h4>
          <ul className="stack">
            {blocks.map((b) => (
              <li key={`${b.kind}:${b.value}`} className="row small">
                <span className="grow">
                  {b.value}{" "}
                  <span className="muted">({b.kind === "server" ? "whole server" : "person"})</span>
                </span>
                <button
                  type="button"
                  className="link"
                  onClick={() => void act(() => api.unblockForLines(b.kind, b.value))}
                >
                  Unblock
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      <button
        type="button"
        className="danger"
        onClick={() => void act(() => api.deleteLine(group.id))}
      >
        Remove the line (frees its address)
      </button>
    </div>
  );
}
