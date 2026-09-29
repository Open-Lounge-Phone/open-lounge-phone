// Team and org spaces as a workplace phone system: the directory with extensions for everyone,
// and for admins the extensions, ring groups, business hours, roles, call log and audit trail.
import { useCallback, useEffect, useState } from "react";
import type {
  AfterHours,
  Api,
  AuditEntry,
  Directory,
  HoursRule,
  HuntStrategy,
  RingGroupInfo,
  SpaceCall,
} from "./api.ts";
import type { Connection } from "./connection.ts";
import { formatDuration } from "./text.ts";
import { Player } from "./Voicemail.tsx";
import { afterHoursText, auditText, hoursText, STRATEGY_TEXT } from "./workplaceText.ts";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const EXT_RE = /^[0-9]{2,6}$/;

interface Props {
  api: Api;
  conn: Connection | undefined;
  onBack(): void;
}

export function Workplace({ api, conn, onBack }: Props) {
  const [dir, setDir] = useState<Directory>();
  const [q, setQ] = useState("");
  const [dial, setDial] = useState("");
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    try {
      setDir(await api.directory(q));
      setError(undefined);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [api, q]);
  useEffect(() => {
    void load();
  }, [load]);

  const admin = dir?.you.role === "owner" || dir?.you.role === "admin";
  const call = (number: string, label: string) => void conn?.callExtension(number, label);

  return (
    <section className="stack">
      <button type="button" className="link back" onClick={onBack}>
        ← Back
      </button>
      <h2>Directory</h2>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <form
        className="card row"
        onSubmit={(e) => {
          e.preventDefault();
          if (EXT_RE.test(dial)) call(dial, `Ext. ${dial}`);
        }}
      >
        <label className="grow">
          <span className="muted small">Dial an extension</span>
          <input
            inputMode="numeric"
            aria-label="Extension to dial"
            placeholder="e.g. 201"
            value={dial}
            onChange={(e) => setDial(e.target.value.replace(/\D/g, "").slice(0, 6))}
          />
        </label>
        <button type="submit" className="primary" disabled={!EXT_RE.test(dial)}>
          Call
        </button>
      </form>
      <input
        type="search"
        aria-label="Search the directory"
        placeholder="Search people, phones, groups or extensions"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      {dir && (
        <>
          <DirList title="People">
            {dir.members.map((m) => (
              <li key={m.id} className="card row">
                <div className="grow">
                  <div className="device-name">
                    {m.name} {m.role !== "member" && <span className="badge">{m.role}</span>}
                  </div>
                  <div className="muted small">
                    {m.extension ? `Ext. ${m.extension} · ` : ""}
                    {m.address ?? ""}
                    {m.available ? "" : " · not taking calls"}
                  </div>
                </div>
                {dir.you.role === "owner" && m.role !== "owner" && (
                  <button
                    type="button"
                    onClick={() =>
                      void api
                        .setRole(m.id, m.role === "admin" ? "member" : "admin")
                        .then(load, (e: Error) => setError(e.message))
                    }
                  >
                    {m.role === "admin" ? "Make member" : "Make admin"}
                  </button>
                )}
                {m.id !== dir.you.id && m.extension && (
                  <button
                    type="button"
                    className="primary"
                    onClick={() => call(m.extension as string, m.name)}
                  >
                    Call
                  </button>
                )}
              </li>
            ))}
          </DirList>
          <DirList title="Ring groups">
            {dir.groups.map((g) => (
              <li key={g.id} className="card row">
                <div className="grow">
                  <div className="device-name">{g.name}</div>
                  <div className="muted small">
                    {g.extension ? `Ext. ${g.extension} · ` : ""}
                    {STRATEGY_TEXT[g.strategy]} · {g.members.join(", ") || "nobody yet"}
                  </div>
                </div>
                {g.extension && (
                  <button
                    type="button"
                    className="primary"
                    onClick={() => call(g.extension as string, g.name)}
                  >
                    Call
                  </button>
                )}
              </li>
            ))}
          </DirList>
          <DirList title="Phones and rooms">
            {dir.phones.map((d) => (
              <li key={d.id} className="card row">
                <div className="grow">
                  <div className="device-name">{d.name}</div>
                  <div className="muted small">
                    {d.extension ? `Ext. ${d.extension} · ` : ""}
                    {d.mode === "lounge" ? "Lounge phone" : `${d.owner ?? "Someone"}'s phone`}
                  </div>
                </div>
                {d.extension && (
                  <button
                    type="button"
                    className="primary"
                    onClick={() => call(d.extension as string, d.name)}
                  >
                    Call
                  </button>
                )}
              </li>
            ))}
            {dir.rooms.map((r) => (
              <li key={r.id} className="card row">
                <div className="grow">
                  <div className="device-name">{r.name}</div>
                  <div className="muted small">
                    {r.extension ? `Ext. ${r.extension} · ` : ""}
                    {r.address ?? "party line"}
                  </div>
                </div>
                <button
                  type="button"
                  className="primary"
                  onClick={() => void conn?.joinRoom({ roomId: r.id })}
                >
                  Join
                </button>
              </li>
            ))}
          </DirList>
          {admin && <Admin api={api} dir={dir} onChanged={load} onError={setError} />}
        </>
      )}
    </section>
  );
}

function DirList({ title, children }: { title: string; children: React.ReactNode[] }) {
  if (children.length === 0) return null;
  return (
    <>
      <h3>{title}</h3>
      <ul className="stack">{children}</ul>
    </>
  );
}

/** One open window per week pattern, or always open. */
function HoursEditor({
  value,
  onSave,
  inherit,
}: {
  value: HoursRule[] | null;
  onSave(v: HoursRule[] | null): void;
  /** Label for "no hours of its own" (a group follows the space). */
  inherit: string;
}) {
  const first = value?.[0];
  const [on, setOn] = useState(!!first);
  const [days, setDays] = useState<number[]>(first?.days ?? [1, 2, 3, 4, 5]);
  const [start, setStart] = useState(first?.start ?? "09:00");
  const [end, setEnd] = useState(first?.end ?? "17:00");
  return (
    <div className="stack">
      <label className="row">
        <input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} />
        <span>{on ? "Open only at these times" : inherit}</span>
      </label>
      {on && (
        <>
          <div className="row wrap">
            {DAYS.map((d, i) => (
              <label key={d} className="row">
                <input
                  type="checkbox"
                  checked={days.includes(i)}
                  onChange={(e) =>
                    setDays(e.target.checked ? [...days, i].sort() : days.filter((x) => x !== i))
                  }
                />
                {d}
              </label>
            ))}
          </div>
          <div className="row">
            <input
              type="time"
              aria-label="Opens"
              value={start}
              onChange={(e) => setStart(e.target.value)}
            />
            <span>to</span>
            <input
              type="time"
              aria-label="Closes"
              value={end}
              onChange={(e) => setEnd(e.target.value)}
            />
          </div>
        </>
      )}
      <button
        type="button"
        disabled={on && days.length === 0}
        onClick={() => onSave(on ? [{ days, start, end }] : null)}
      >
        Save hours
      </button>
    </div>
  );
}

function AfterHoursPicker({
  value,
  dir,
  self,
  onSave,
  inherit,
}: {
  value: AfterHours | null;
  dir: Directory;
  self?: string;
  onSave(v: AfterHours | null): void;
  inherit?: string;
}) {
  const encode = (v: AfterHours | null) =>
    !v
      ? ""
      : v.kind === "voicemail"
        ? "vm"
        : v.kind === "group"
          ? `g:${v.groupId}`
          : `u:${v.userId}`;
  const decode = (s: string): AfterHours | null =>
    s === ""
      ? null
      : s === "vm"
        ? { kind: "voicemail" }
        : s.startsWith("g:")
          ? { kind: "group", groupId: s.slice(2) }
          : { kind: "user", userId: s.slice(2) };
  return (
    <label className="stack">
      <span className="muted small">After hours</span>
      <select value={encode(value)} onChange={(e) => onSave(decode(e.target.value))}>
        {inherit && <option value="">{inherit}</option>}
        <option value="vm">Voicemail (the group's shared box)</option>
        {dir.groups
          .filter((g) => g.id !== self)
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
      </select>
    </label>
  );
}

function Admin({
  api,
  dir,
  onChanged,
  onError,
}: {
  api: Api;
  dir: Directory;
  onChanged(): void;
  onError(m: string): void;
}) {
  const [groups, setGroups] = useState<RingGroupInfo[]>([]);
  const [space, setSpace] = useState<{
    hours: HoursRule[] | null;
    afterHours: AfterHours | null;
  }>();
  const [calls, setCalls] = useState<SpaceCall[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [tab, setTab] = useState<"numbers" | "groups" | "hours" | "log" | "audit">("numbers");

  const reload = useCallback(async () => {
    try {
      const [g, h, c, a] = await Promise.all([
        api.groups(),
        api.spaceHours(),
        api.spaceCalls(),
        api.audit(),
      ]);
      setGroups(g);
      setSpace(h);
      setCalls(c);
      setAudit(a);
    } catch (e) {
      onError((e as Error).message);
    }
  }, [api, onError]);
  useEffect(() => {
    void reload();
  }, [reload]);

  const act = (p: Promise<unknown>) =>
    void p.then(
      () => {
        onChanged();
        void reload();
      },
      (e: Error) => onError(e.message),
    );

  const nameOf = (id: string) => dir.members.find((m) => m.id === id)?.name ?? "someone";

  return (
    <section className="card stack">
      <h3>Admin</h3>
      <nav className="row wrap" aria-label="Admin sections">
        {(
          [
            ["numbers", "Extensions"],
            ["groups", "Ring groups"],
            ["hours", "Business hours"],
            ["log", "Call log"],
            ["audit", "Audit trail"],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            type="button"
            className="tab"
            aria-current={tab === k ? "page" : undefined}
            onClick={() => setTab(k)}
          >
            {label}
          </button>
        ))}
      </nav>
      {tab === "numbers" && <Extensions api={api} dir={dir} act={act} />}
      {tab === "groups" && <Groups api={api} dir={dir} groups={groups} act={act} nameOf={nameOf} />}
      {tab === "hours" && space && (
        <div className="stack">
          <p className="muted small">
            Business hours apply to ring groups (a group can have its own). Calls to people go by
            their own availability. Now: {hoursText(space.hours)}.
          </p>
          <HoursEditor
            key={JSON.stringify(space.hours)}
            value={space.hours}
            inherit="Always open"
            onSave={(hours) => act(api.setSpaceHours({ hours }))}
          />
          <AfterHoursPicker
            value={space.afterHours}
            dir={dir}
            inherit="Voicemail (the called group's box)"
            onSave={(afterHours) => act(api.setSpaceHours({ afterHours }))}
          />
        </div>
      )}
      {tab === "log" && (
        <div className="stack">
          <div className="row">
            <button
              type="button"
              onClick={() =>
                void api.spaceCallsCsv().then(
                  (blob) => {
                    const a = document.createElement("a");
                    a.href = URL.createObjectURL(blob);
                    a.download = "call-log.csv";
                    a.click();
                    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
                  },
                  (e: Error) => onError(e.message),
                )
              }
            >
              Export CSV
            </button>
            <span className="muted small">Kept as long as the space's history setting.</span>
          </div>
          <ul className="stack">
            {calls.map((c) => (
              <li key={c.id} className="row small">
                <span className="grow">
                  {new Date(c.startedAt).toLocaleString()} · {c.who}{" "}
                  {c.direction === "out" ? "→" : "←"} {c.peerLabel || c.peer}
                </span>
                <span className="muted">
                  {c.answered ? formatDuration(c.durationMs) : (c.endReason ?? "missed")}
                  {c.voicemailId ? " · voicemail" : ""}
                  {c.recordingId ? " · recorded" : ""}
                </span>
                {c.recordingId && (
                  <Player
                    api={api}
                    voicemail={{ id: c.recordingId }}
                    fetchAudio={api.recordingAudio}
                    onFinished={() => {}}
                  />
                )}
              </li>
            ))}
            {calls.length === 0 && <li className="muted">No calls yet.</li>}
          </ul>
        </div>
      )}
      {tab === "audit" && (
        <ul className="stack">
          {audit.map((e) => (
            <li key={e.id} className="small">
              <span className="muted">{new Date(e.at).toLocaleString()}</span> · {e.actorName}{" "}
              {auditText(e.action, e.detail)}
            </li>
          ))}
          {audit.length === 0 && <li className="muted">No changes yet.</li>}
        </ul>
      )}
    </section>
  );
}

function Extensions({
  api,
  dir,
  act,
}: {
  api: Api;
  dir: Directory;
  act(p: Promise<unknown>): void;
}) {
  const [number, setNumber] = useState("");
  const [target, setTarget] = useState("");
  const targets = [
    ...dir.members.map((m) => ({ key: `user:${m.id}`, label: m.name, ext: m.extension })),
    ...dir.phones.map((p) => ({ key: `device:${p.id}`, label: p.name, ext: p.extension })),
    ...dir.rooms.map((r) => ({ key: `room:${r.id}`, label: r.name, ext: r.extension })),
  ];
  return (
    <div className="stack">
      <form
        className="row wrap"
        onSubmit={(e) => {
          e.preventDefault();
          const [kind, id] = target.split(":") as ["user" | "device" | "room", string];
          act(api.setExtension(number, kind, id));
          setNumber("");
        }}
      >
        <input
          inputMode="numeric"
          aria-label="Extension number"
          placeholder="201"
          value={number}
          onChange={(e) => setNumber(e.target.value.replace(/\D/g, "").slice(0, 6))}
        />
        <select aria-label="For" value={target} onChange={(e) => setTarget(e.target.value)}>
          <option value="">For…</option>
          {targets.map((t) => (
            <option key={t.key} value={t.key}>
              {t.label}
              {t.ext ? ` (now ${t.ext})` : ""}
            </option>
          ))}
        </select>
        <button type="submit" disabled={!EXT_RE.test(number) || !target}>
          Set
        </button>
      </form>
      <ul className="stack">
        {targets
          .filter((t) => t.ext)
          .map((t) => (
            <li key={t.key} className="row">
              <span className="grow">
                {t.ext} · {t.label}
              </span>
              <button
                type="button"
                className="link"
                onClick={() => act(api.deleteExtension(t.ext as string))}
              >
                Remove
              </button>
            </li>
          ))}
      </ul>
      <p className="muted small">Ring groups get their number when you make them.</p>
    </div>
  );
}

function Groups({
  api,
  dir,
  groups,
  act,
  nameOf,
}: {
  api: Api;
  dir: Directory;
  groups: RingGroupInfo[];
  act(p: Promise<unknown>): void;
  nameOf(id: string): string;
}) {
  const [name, setName] = useState("");
  const [ext, setExt] = useState("");
  const [strategy, setStrategy] = useState<HuntStrategy>("simultaneous");
  const [ring, setRing] = useState(20);
  const [members, setMembers] = useState<string[]>([]);
  return (
    <div className="stack">
      {groups.map((g) => (
        <details key={g.id} className="card">
          <summary>
            {g.name} · Ext. {g.extension} · {STRATEGY_TEXT[g.strategy]} ·{" "}
            {g.members.map(nameOf).join(", ") || "nobody yet"}
          </summary>
          <div className="stack">
            <label className="stack">
              <span className="muted small">How it rings</span>
              <select
                value={g.strategy}
                onChange={(e) =>
                  act(api.updateGroup(g.id, { strategy: e.target.value as HuntStrategy }))
                }
              >
                {Object.entries(STRATEGY_TEXT).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
            <MemberPicker
              dir={dir}
              value={g.members}
              onChange={(m) => act(api.updateGroup(g.id, { members: m }))}
            />
            <p className="muted small">
              Hours: {g.hours ? hoursText(g.hours) : "the space's"} · after hours:{" "}
              {afterHoursText(g.afterHours, dir)}
            </p>
            <HoursEditor
              key={JSON.stringify(g.hours)}
              value={g.hours}
              inherit="Same hours as the space"
              onSave={(hours) => act(api.updateGroup(g.id, { hours }))}
            />
            <AfterHoursPicker
              value={g.afterHours}
              dir={dir}
              self={g.id}
              inherit="Same as the space"
              onSave={(afterHours) => act(api.updateGroup(g.id, { afterHours }))}
            />
            <button type="button" className="danger" onClick={() => act(api.deleteGroup(g.id))}>
              Delete group (and its voicemail)
            </button>
          </div>
        </details>
      ))}
      <form
        className="card stack"
        onSubmit={(e) => {
          e.preventDefault();
          act(api.createGroup({ name, extension: ext, strategy, ringSeconds: ring, members }));
          setName("");
          setExt("");
          setMembers([]);
        }}
      >
        <h4>New ring group</h4>
        <input
          aria-label="Group name"
          placeholder="Front desk"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          inputMode="numeric"
          aria-label="Group extension"
          placeholder="Extension, e.g. 100"
          value={ext}
          onChange={(e) => setExt(e.target.value.replace(/\D/g, "").slice(0, 6))}
        />
        <select
          aria-label="How it rings"
          value={strategy}
          onChange={(e) => setStrategy(e.target.value as HuntStrategy)}
        >
          {Object.entries(STRATEGY_TEXT).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <label className="row">
          <span>Ring each step for</span>
          <input
            type="number"
            min={5}
            max={120}
            value={ring}
            onChange={(e) => setRing(Number(e.target.value))}
          />
          <span>seconds</span>
        </label>
        <MemberPicker dir={dir} value={members} onChange={setMembers} />
        <button type="submit" className="primary" disabled={!name.trim() || !EXT_RE.test(ext)}>
          Make group
        </button>
      </form>
    </div>
  );
}

function MemberPicker({
  dir,
  value,
  onChange,
}: {
  dir: Directory;
  value: string[];
  onChange(v: string[]): void;
}) {
  return (
    <fieldset className="row wrap">
      <legend className="muted small">Members, in ring order</legend>
      {dir.members.map((m) => (
        <label key={m.id} className="row">
          <input
            type="checkbox"
            checked={value.includes(m.id)}
            onChange={(e) =>
              onChange(e.target.checked ? [...value, m.id] : value.filter((x) => x !== m.id))
            }
          />
          {m.name}
        </label>
      ))}
    </fieldset>
  );
}
