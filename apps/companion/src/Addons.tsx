// Settings → Add-ons (docs/add-ons.md): services linked to your own account, such as an AI
// companion or a notes taker. Each has an address on your account (`you+name@host`); only you,
// and the connections you choose, can talk to it. Online/offline is what the server reports.
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { addonNameProblem, addonPreview } from "./addonText.ts";
import type { AddonView, Api, ConnectionView } from "./api.ts";
import type { Connection } from "./connection.ts";
import { formatWhen } from "./text.ts";

/** How often the list is read again while it's open (online/offline as the server says). */
const REFRESH_MS = 15_000;

export function Addons({
  api,
  conn,
  address,
}: {
  api: Api;
  conn: Connection | undefined;
  /** Your own address (`handle@host`), for the new add-on's address. */
  address: string | undefined;
}) {
  const [info, setInfo] = useState<{ enabled: boolean; addons: AddonView[] }>();
  const [people, setPeople] = useState<ConnectionView[]>([]);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [linking, setLinking] = useState(false);

  const load = useCallback(() => {
    api.addons().then(
      (r) => {
        setInfo(r);
        setError(undefined);
      },
      (e: Error) => setError(e.message),
    );
  }, [api]);
  useEffect(() => {
    load();
    api.connections().then(
      (c) => setPeople(c.connections.filter((x) => x.state === "active")),
      () => {},
    );
    const t = setInterval(load, REFRESH_MS);
    return () => clearInterval(t);
  }, [api, load]);

  return (
    <div className="card stack addons">
      <h3>Add-ons</h3>
      <p className="hint">
        Services you link to your account, like an AI companion or a notes taker. Each gets its own
        address on your account. Only you, and the connections you choose, can talk to it. Nobody
        else can call it or knock on it, and kids' phones never reach one.
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="muted small" role="status">
          {notice}
        </p>
      )}
      {info && !info.enabled && (
        <p className="muted">
          This server doesn't offer add-ons. Its operator can turn them on.
          {info.addons.length > 0 &&
            " While they're off, your add-ons can't connect and nobody can call them."}
        </p>
      )}
      {info && info.addons.length === 0 && info.enabled && !linking && (
        <p className="muted small">No add-ons yet.</p>
      )}
      {info && info.addons.length > 0 && (
        <ul className="stack">
          {info.addons.map((a) => (
            <AddonRow
              key={a.id}
              addon={a}
              api={api}
              conn={conn}
              people={people}
              enabled={info.enabled}
              onChanged={load}
              onNotice={setNotice}
              onError={setError}
            />
          ))}
        </ul>
      )}
      {info?.enabled &&
        (linking ? (
          <LinkForm
            api={api}
            address={address}
            people={people}
            onDone={(a) => {
              setLinking(false);
              setNotice(`Linked. ${a.name} is at ${a.address}.`);
              load();
            }}
            onCancel={() => setLinking(false)}
          />
        ) : (
          <button type="button" onClick={() => setLinking(true)}>
            Link an add-on
          </button>
        ))}
    </div>
  );
}

function AddonRow({
  addon,
  api,
  conn,
  people,
  enabled,
  onChanged,
  onNotice,
  onError,
}: {
  addon: AddonView;
  api: Api;
  conn: Connection | undefined;
  people: ConnectionView[];
  enabled: boolean;
  onChanged(): void;
  onNotice(text: string): void;
  onError(text: string): void;
}) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const allowedNames = people.filter((p) => addon.allow.includes(p.id)).map((p) => p.name);
  const status = addon.online
    ? "Online"
    : addon.lastSeen
      ? `Offline · last seen ${formatWhen(addon.lastSeen, Date.now())}`
      : "Offline · hasn't connected yet";
  const remove = async () => {
    if (
      !window.confirm(
        `Remove ${addon.name}? It's cut off at once and its address stops working. To use it again, link it again.`,
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      await api.removeAddon(addon.id);
      onNotice(`${addon.name} was removed.`);
      onChanged();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="stack addon">
      <div className="row">
        <span className={`dot ${addon.online ? "on" : "off"}`} aria-hidden title={status} />
        <strong>{addon.name}</strong> <span className="badge">add-on</span>
      </div>
      <div className="row wrap">
        <code className="small">{addon.address}</code>
        <button
          type="button"
          className="link"
          onClick={() =>
            void navigator.clipboard?.writeText(addon.address).then(
              () => onNotice("Address copied."),
              () => onError("Couldn't copy; select it instead."),
            )
          }
        >
          Copy
        </button>
      </div>
      <div className="muted small">
        {status} · in {addon.space}
      </div>
      <div className="muted small">
        {allowedNames.length
          ? `You and ${allowedNames.join(", ")} can talk to it.`
          : "Only you can talk to it."}
      </div>
      {editing ? (
        <AllowEditor
          people={people}
          initial={addon.allow}
          onSave={async (ids) => {
            try {
              await api.setAddonAllow(addon.id, ids);
              setEditing(false);
              onNotice("Saved.");
              onChanged();
            } catch (e) {
              onError((e as Error).message);
            }
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <div className="row wrap">
          <button
            type="button"
            disabled={!enabled || !conn}
            onClick={() => void conn?.callAddon(addon.address, addon.name)}
          >
            Call
          </button>
          <button type="button" onClick={() => setEditing(true)}>
            Who may talk to it
          </button>
          <button type="button" className="danger" disabled={busy} onClick={() => void remove()}>
            Remove
          </button>
        </div>
      )}
    </li>
  );
}

/** Checkboxes: which of your connections may talk to it (and it to them). */
function AllowChoices({
  people,
  value,
  onChange,
}: {
  people: ConnectionView[];
  value: string[];
  onChange(ids: string[]): void;
}) {
  return (
    <fieldset className="stack">
      <legend>Who may talk to it, besides you</legend>
      {people.length === 0 && (
        <p className="muted small">
          You have no connections yet. Connect with someone first (Connections), then come back.
        </p>
      )}
      {people.map((p) => (
        <label key={p.id} className="row">
          <input
            type="checkbox"
            checked={value.includes(p.id)}
            onChange={(e) =>
              onChange(e.target.checked ? [...value, p.id] : value.filter((id) => id !== p.id))
            }
          />
          <span>
            {p.name || p.address} <span className="muted small">{p.address}</span>
          </span>
        </label>
      ))}
      <span className="hint">
        They can call it, and it can call them. It's told who is calling every time.
      </span>
    </fieldset>
  );
}

/** Changing who may talk to a linked add-on. */
function AllowEditor({
  people,
  initial,
  onSave,
  onCancel,
}: {
  people: ConnectionView[];
  initial: string[];
  onSave(ids: string[]): Promise<void>;
  onCancel(): void;
}) {
  const [chosen, setChosen] = useState(initial);
  return (
    <div className="stack">
      <AllowChoices people={people} value={chosen} onChange={setChosen} />
      <div className="row">
        <button type="button" className="primary" onClick={() => void onSave(chosen)}>
          Save
        </button>
        <button type="button" className="link" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function LinkForm({
  api,
  address,
  people,
  onDone,
  onCancel,
}: {
  api: Api;
  address: string | undefined;
  people: ConnectionView[];
  onDone(a: AddonView): void;
  onCancel(): void;
}) {
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [allow, setAllow] = useState<string[]>([]);
  const [problem, setProblem] = useState<{ code?: string; name?: string }>({});
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const next = {
      ...(/^\d{6}$/.test(code) ? {} : { code: "Type the 6 digits the add-on shows." }),
      ...(addonNameProblem(name) ? { name: addonNameProblem(name) } : {}),
    };
    setProblem(next);
    if (next.code || next.name) return;
    setBusy(true);
    setError(undefined);
    try {
      onDone(await api.linkAddon({ code, name: name.trim().toLowerCase(), allow }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const preview = addonPreview(address, name);
  return (
    <form className="stack" noValidate onSubmit={(e) => void submit(e)}>
      <h4>Link an add-on</h4>
      <p className="hint">
        Start linking in the add-on (for example "Connect a phone"). It shows a 6-digit code.
      </p>
      <label>
        Code
        <input
          inputMode="numeric"
          autoComplete="one-time-code"
          value={code}
          maxLength={6}
          aria-invalid={problem.code ? true : undefined}
          onChange={(e) => {
            setCode(e.target.value.replace(/\D/g, "").slice(0, 6));
            setProblem({ ...problem, code: undefined });
          }}
        />
        {problem.code && <span className="hint error">{problem.code}</span>}
      </label>
      <label>
        Name
        <input
          value={name}
          maxLength={30}
          placeholder="seat"
          aria-invalid={problem.name ? true : undefined}
          onChange={(e) => {
            setName(e.target.value);
            setProblem({ ...problem, name: undefined });
          }}
        />
        <span className={problem.name ? "hint error" : "hint"}>
          {problem.name ??
            (preview ? `Its address: ${preview}` : "The part after + in its address.")}
        </span>
      </label>
      <AllowChoices people={people} value={allow} onChange={setAllow} />
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="row">
        <button type="submit" className="primary" disabled={busy}>
          {busy ? "Linking…" : "Link"}
        </button>
        <button type="button" className="link" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
