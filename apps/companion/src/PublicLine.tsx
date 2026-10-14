// A ring group's public line (team and org admins): its address, the warning before it goes
// public, who may call, the queue, voicemail and its greeting, limits, recent callers and the
// space's blocklist. See docs/workplace.md "Public lines".
import { LINE_ENDED_NOTE, LINE_QUEUE_MAX, LINE_WAIT_MAX_SECONDS } from "@openloungephone/core";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Api, Directory, LineCaller, LinePatch, LineSettings, RingGroupInfo } from "./api.ts";
import { allowList, wholeNumber } from "./fields.ts";
import { handleHint, normalizeHandle } from "./handles.ts";
import { VoicemailRecorder } from "./recording.ts";
import { maxWaitText, WHO_TEXT } from "./workplaceText.ts";

type Blocks = Awaited<ReturnType<Api["lineBlocks"]>>;

/** The server's top for a line's own per-hour limits. */
const PER_HOUR_MAX = 10_000;

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
  const [handleTried, setHandleTried] = useState(false);
  const [error, setError] = useState<string>();
  /** What's wrong with a field (by name) after leaving it; it isn't saved until fixed. */
  const [problems, setProblems] = useState<Record<string, string | undefined>>({});
  const problem = (field: string, text: string | undefined) =>
    setProblems((p) => ({ ...p, [field]: text }));
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
    const hint = handleHint(handle);
    const showHint = handleTried && hint;
    return (
      <form
        className="stack"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          setHandleTried(true);
          if (!hint) void save({ handle });
        }}
      >
        <h4>Public line</h4>
        <p className="muted small">
          Give this group its own address, like help-desk@this-server, so people on any server can
          call it without connecting first. It stays off until you turn it on.
        </p>
        <label className="stack">
          <span className="muted small">Line address (the part before @)</span>
          <div className="row">
            <input
              value={handle}
              maxLength={30}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              aria-invalid={showHint ? true : undefined}
              onChange={(e) => setHandle(normalizeHandle(e.target.value))}
            />
            <button type="submit">Choose address</button>
          </div>
          <span className={showHint ? "hint error" : "hint"}>
            {showHint
              ? hint
              : "Lower-case letters, digits, dots, dashes or underscores, for example help-desk."}
          </span>
        </label>
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
  /** A per-hour limit: empty = the server's; else 1 up to the server's (it caps them anyway). */
  const perHour = (field: string, v: string, serverMax: number) => {
    if (v.trim() === "") {
      problem(field, undefined);
      return null;
    }
    const n = wholeNumber(v, 1, Math.min(serverMax, PER_HOUR_MAX));
    if ("problem" in n) {
      problem(field, `${n.problem.replace(/\.$/, "")}, or leave it empty.`);
      return undefined;
    }
    problem(field, undefined);
    return n.value;
  };
  const fieldHint = (field: string, hint: string) => (
    <span className={problems[field] ? "hint error" : "muted small"}>
      {problems[field] ?? hint}
    </span>
  );
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
        <span className="muted small">Name callers see (optional)</span>
        <input
          defaultValue={line.displayName ?? ""}
          maxLength={64}
          onBlur={(e) =>
            e.target.value.trim() !== (line.displayName ?? "") &&
            void save({ displayName: e.target.value.trim() || null })
          }
        />
        <span className="muted small">Empty: they see {group.name}.</span>
      </label>
      <label className="stack">
        <span className="muted small">One line about it (optional)</span>
        <input
          defaultValue={line.description ?? ""}
          maxLength={140}
          onBlur={(e) =>
            e.target.value.trim() !== (line.description ?? "") &&
            void save({ description: e.target.value.trim() || null })
          }
        />
        <span className="muted small">For example, Questions about your order.</span>
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
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            aria-invalid={problems.allow ? true : undefined}
            onBlur={(e) => {
              const list = allowList(e.target.value);
              problem("allow", "problem" in list ? list.problem : undefined);
              if ("entries" in list) void save({ allow: list.entries });
            }}
          />
          {fieldHint("allow", "A whole server (example.org) or one address (name@example.org).")}
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
                inputMode="numeric"
                min={1}
                max={LINE_QUEUE_MAX}
                defaultValue={line.queueMax}
                aria-invalid={problems.queueMax ? true : undefined}
                onBlur={(e) => {
                  const n = wholeNumber(e.target.value, 1, LINE_QUEUE_MAX);
                  problem("queueMax", "problem" in n ? n.problem : undefined);
                  if ("value" in n && n.value !== line.queueMax) void save({ queueMax: n.value });
                }}
              />
              <span>callers waiting</span>
            </label>
            {problems.queueMax && <span className="hint error">{problems.queueMax}</span>}
            <label className="row">
              <span>For at most</span>
              <input
                type="number"
                inputMode="numeric"
                min={1}
                max={LINE_WAIT_MAX_SECONDS / 60}
                defaultValue={Math.round(line.queueWaitSeconds / 60)}
                aria-invalid={problems.queueWait ? true : undefined}
                onBlur={(e) => {
                  const n = wholeNumber(e.target.value, 1, LINE_WAIT_MAX_SECONDS / 60);
                  problem("queueWait", "problem" in n ? n.problem : undefined);
                  if ("value" in n && n.value * 60 !== line.queueWaitSeconds) {
                    void save({ queueWaitSeconds: n.value * 60 });
                  }
                }}
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
            {problems.queueWait && <span className="hint error">{problems.queueWait}</span>}
            {wait.kind === "end" && (
              <label className="stack">
                <span className="muted small">What callers see when it ends (optional)</span>
                <input
                  maxLength={140}
                  defaultValue={wait.message ?? ""}
                  onBlur={(e) =>
                    e.target.value.trim() !== (wait.message ?? "") &&
                    void save({
                      atMaxWait: e.target.value.trim()
                        ? { kind: "end", message: e.target.value.trim() }
                        : { kind: "end" },
                    })
                  }
                />
                <span className="muted small">Empty: “{LINE_ENDED_NOTE}”</span>
              </label>
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
            <label className="row">
              <input
                type="checkbox"
                checked={line.callback}
                onChange={(e) => void save({ callback: e.target.checked })}
              />
              <span>Offer "Call me back": they hang up and keep their place</span>
            </label>
            {line.callback && (
              <label className="row">
                <span>If they miss the call back</span>
                <select
                  value={line.callbackMissed}
                  onChange={(e) =>
                    void save({ callbackMissed: e.target.value as LineSettings["callbackMissed"] })
                  }
                >
                  <option value="retry">try once more later, then offer voicemail</option>
                  <option value="voicemail">offer voicemail</option>
                </select>
              </label>
            )}
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
            inputMode="numeric"
            min={1}
            max={line.limits.callerPerHour}
            defaultValue={line.callerPerHour ?? ""}
            aria-invalid={problems.callerPerHour ? true : undefined}
            onBlur={(e) => {
              const n = perHour("callerPerHour", e.target.value, line.limits.callerPerHour);
              if (n !== undefined && n !== line.callerPerHour) void save({ callerPerHour: n });
            }}
          />
        </label>
        <label className="row">
          <span>Each other server</span>
          <input
            type="number"
            inputMode="numeric"
            min={1}
            max={line.limits.serverPerHour}
            defaultValue={line.serverPerHour ?? ""}
            aria-invalid={problems.serverPerHour ? true : undefined}
            onBlur={(e) => {
              const n = perHour("serverPerHour", e.target.value, line.limits.serverPerHour);
              if (n !== undefined && n !== line.serverPerHour) void save({ serverPerHour: n });
            }}
          />
        </label>
        {fieldHint(
          problems.callerPerHour ? "callerPerHour" : "serverPerHour",
          `Empty: this server's limits, ${line.limits.callerPerHour} per caller and ${line.limits.serverPerHour} per server.`,
        )}
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
