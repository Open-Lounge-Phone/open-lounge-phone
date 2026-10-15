// Settings → Add-ons (docs/add-ons.md): services linked to your own account, such as an AI
// companion or a notes taker. Each has an address on your account (`you+name@host`) that only you
// can call. What it offers for sharing (its shares) you can give to people; each share has its
// own address, for them. Online/offline is what the server reports.
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { addonNameProblem, addonPreview, shareRequestText } from "./addonText.ts";
import type { AddonPerson, AddonShareView, AddonView, Api, ShareRequestView } from "./api.ts";
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
  const [people, setPeople] = useState<AddonPerson[]>([]);
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
    api.addonPeople().then(setPeople, () => {});
    const t = setInterval(load, REFRESH_MS);
    return () => clearInterval(t);
  }, [api, load]);

  return (
    <div className="card stack addons">
      <h3>Add-ons</h3>
      <p className="hint">
        Services you link to your account, like an AI companion or a notes taker. Each gets its own
        address on your account, and you call it like a person. Only you can call it there. If it
        offers parts of itself for sharing, like one shared project, you can give a part to people:
        they call that part at its own address, and nothing else. Nobody can knock on an add-on, and
        kids' phones never reach one.
      </p>
      <ol className="addon-steps">
        <li>
          In the service, choose to connect it to Open Lounge Phone and give it your server's
          address: <code>{location.host}</code>{" "}
          <button
            type="button"
            className="link"
            onClick={() => void navigator.clipboard?.writeText(location.host)}
          >
            Copy
          </button>
        </li>
        <li>It shows a 6-digit code. Choose Link an add-on below and type it in.</li>
        <li>Call it from here, or put it on a key of your own phone.</li>
      </ol>
      <p className="muted small">
        The service has to support Open Lounge Phone. You can also{" "}
        <a href="https://openloungephone.app/how-to/add-ons/" target="_blank" rel="noreferrer">
          build your own
        </a>
        .
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
  people: AddonPerson[];
  enabled: boolean;
  onChanged(): void;
  onNotice(text: string): void;
  onError(text: string): void;
}) {
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const status = addon.online
    ? "Online"
    : addon.lastSeen
      ? `Offline · last seen ${formatWhen(addon.lastSeen, Date.now())}`
      : "Offline · hasn't connected yet";
  const copy = (text: string) =>
    void navigator.clipboard?.writeText(text).then(
      () => onNotice("Address copied."),
      () => onError("Couldn't copy; select it instead."),
    );
  const act = async (work: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    try {
      await work();
      if (done) onNotice(done);
      onChanged();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (
      !window.confirm(
        `Remove ${addon.name}? It's cut off at once and its address stops working. To use it again, link it again.`,
      )
    ) {
      return;
    }
    await act(() => api.removeAddon(addon.id), `${addon.name} was removed.`);
  };
  return (
    <li className="stack addon">
      <div className="row">
        <span className={`dot ${addon.online ? "on" : "off"}`} aria-hidden title={status} />
        <strong>{addon.name}</strong> <span className="badge">add-on</span>
      </div>
      <div className="row wrap">
        <code className="small">{addon.address}</code>
        <button type="button" className="link" onClick={() => copy(addon.address)}>
          Copy
        </button>
      </div>
      <div className="muted small">
        {status} · in {addon.space} · only you can call it at this address
      </div>
      {addon.allowNote && (
        <div className="notice row wrap" role="status">
          <span>
            The people you had let talk to {addon.name} were removed. Sharing now works per share:
            give someone one of its shares below.
          </span>
          <button
            type="button"
            className="link"
            onClick={() => void act(() => api.dismissAddonNote(addon.id))}
          >
            OK
          </button>
        </div>
      )}
      <h4>Shares</h4>
      {addon.shares.length === 0 ? (
        <p className="muted small">
          {addon.name} doesn't offer anything for sharing yet. When it does, its shares show up here
          and you can give them to people.
        </p>
      ) : (
        <ul className="stack addon-shares">
          {addon.shares.map((s) => (
            <ShareRow
              key={s.id}
              share={s}
              people={people}
              busy={busy}
              enabled={enabled}
              onCopy={copy}
              onGive={(ref, name) =>
                act(() => api.giveShare(addon.id, s.id, ref), `${s.label} is shared with ${name}.`)
              }
              onRevoke={(h) => {
                if (
                  !window.confirm(
                    `Take ${s.label} back from ${h.name}? A call of theirs into it ends now.`,
                  )
                ) {
                  return;
                }
                void act(
                  () => api.revokeShare(addon.id, h.grantId),
                  `${h.name} no longer has ${s.label}.`,
                );
              }}
            />
          ))}
        </ul>
      )}
      {asking ? (
        <NewShareForm
          addon={addon}
          api={api}
          people={people}
          onClose={() => {
            setAsking(false);
            onChanged();
          }}
          onChanged={onChanged}
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
          <button type="button" disabled={!enabled} onClick={() => setAsking(true)}>
            New shared project with…
          </button>
          <button type="button" className="danger" disabled={busy} onClick={() => void remove()}>
            Remove
          </button>
        </div>
      )}
    </li>
  );
}

/** One share: its address, who holds it (Revoke), and Give to…. */
function ShareRow({
  share,
  people,
  busy,
  enabled,
  onCopy,
  onGive,
  onRevoke,
}: {
  share: AddonShareView;
  people: AddonPerson[];
  busy: boolean;
  enabled: boolean;
  onCopy(text: string): void;
  onGive(ref: string, name: string): Promise<void>;
  onRevoke(h: AddonShareView["holders"][number]): void;
}) {
  const [giving, setGiving] = useState(false);
  const [choice, setChoice] = useState("");
  const holding = new Set(share.holders.map((h) => h.address));
  const free = people.filter((p) => !holding.has(p.address));
  return (
    <li className="stack">
      <div className="row wrap">
        <strong>{share.label}</strong>
        <code className="small">{share.address}</code>
        <button type="button" className="link" onClick={() => onCopy(share.address)}>
          Copy
        </button>
      </div>
      {share.holders.length === 0 ? (
        <span className="muted small">Nobody has it yet.</span>
      ) : (
        <ul className="stack">
          {share.holders.map((h) => (
            <li key={h.grantId} className="row wrap">
              <span>
                {h.name} <span className="muted small">{h.address}</span>
              </span>
              <button type="button" className="link danger" onClick={() => onRevoke(h)}>
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}
      {giving ? (
        <div className="row wrap">
          <label>
            <span className="sr-only">Give {share.label} to</span>
            <select value={choice} onChange={(e) => setChoice(e.target.value)}>
              <option value="">Choose someone…</option>
              {free.map((p) => (
                <option key={p.ref} value={p.ref}>
                  {p.name} ({p.address})
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="primary"
            disabled={!choice || busy}
            onClick={() => {
              const who = free.find((p) => p.ref === choice);
              void onGive(choice, who?.name ?? "them").then(() => {
                setGiving(false);
                setChoice("");
              });
            }}
          >
            Give
          </button>
          <button type="button" className="link" onClick={() => setGiving(false)}>
            Cancel
          </button>
          {free.length === 0 && (
            <span className="hint">
              Nobody else to give it to: connect with someone first, or invite them to one of your
              spaces.
            </span>
          )}
        </div>
      ) : (
        <div className="row">
          <button type="button" disabled={!enabled} onClick={() => setGiving(true)}>
            Give to…
          </button>
        </div>
      )}
      <span className="hint">
        Whoever has it can call this address, and {share.label} only. It can call them within it.
      </span>
    </li>
  );
}

/** How often a share request is read again while the add-on hasn't answered. */
const REQUEST_POLL_MS = 1_000;

/** "New shared project with…": a name and people; the add-on makes it, then they get it. */
function NewShareForm({
  addon,
  api,
  people,
  onClose,
  onChanged,
}: {
  addon: AddonView;
  api: Api;
  people: AddonPerson[];
  onClose(): void;
  onChanged(): void;
}) {
  const [label, setLabel] = useState("");
  const [chosen, setChosen] = useState<string[]>([]);
  const [problem, setProblem] = useState<string>();
  const [error, setError] = useState<string>();
  const [request, setRequest] = useState<ShareRequestView>();
  const waiting = request?.state === "waiting";

  useEffect(() => {
    if (!request || request.state !== "waiting") {
      if (request?.state === "created") onChanged();
      return;
    }
    const t = setTimeout(() => {
      api.shareRequest(addon.id, request.id).then(setRequest, (e: Error) => setError(e.message));
    }, REQUEST_POLL_MS);
    return () => clearTimeout(t);
  }, [api, addon.id, request, onChanged]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!label.trim()) {
      setProblem("Give it a name, like Book club.");
      return;
    }
    setError(undefined);
    try {
      setRequest(await api.askForShare(addon.id, label.trim(), chosen));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <form className="stack" noValidate onSubmit={(e) => void submit(e)}>
      <h4>New shared project with…</h4>
      <p className="hint">
        {addon.name} makes a new shared part of itself for these people. Then they can call it at
        its own address, and only that part.
      </p>
      <label>
        Name
        <input
          value={label}
          maxLength={40}
          disabled={waiting}
          aria-invalid={problem ? true : undefined}
          onChange={(e) => {
            setLabel(e.target.value);
            setProblem(undefined);
          }}
        />
        {problem && <span className="hint error">{problem}</span>}
      </label>
      <fieldset className="choice">
        <legend>With</legend>
        {people.length === 0 && (
          <p className="muted small">
            You have no connections or people in your spaces yet. You can still ask, and give it to
            people later.
          </p>
        )}
        {people.map((p) => (
          <label key={p.ref} className="check">
            <input
              type="checkbox"
              disabled={waiting}
              checked={chosen.includes(p.ref)}
              onChange={(e) =>
                setChosen(e.target.checked ? [...chosen, p.ref] : chosen.filter((r) => r !== p.ref))
              }
            />
            <span>
              {p.name} <span className="muted small">{p.address}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {request && (
        <p className={request.state === "created" ? "notice" : "muted"} role="status">
          {shareRequestText(addon.name, request)}
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="row">
        {(!request || (request.state !== "waiting" && request.state !== "created")) && (
          <button type="submit" className="primary">
            {request ? "Ask again" : "Ask"}
          </button>
        )}
        <button type="button" className="link" onClick={onClose}>
          {request?.state === "created" ? "Done" : "Cancel"}
        </button>
      </div>
    </form>
  );
}

function LinkForm({
  api,
  address,
  onDone,
  onCancel,
}: {
  api: Api;
  address: string | undefined;
  onDone(a: AddonView): void;
  onCancel(): void;
}) {
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
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
      onDone(await api.linkAddon({ code, name: name.trim().toLowerCase() }));
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
        Start linking in the service first: it shows a 6-digit code for a few minutes.
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
          aria-invalid={problem.name ? true : undefined}
          onChange={(e) => {
            setName(e.target.value);
            setProblem({ ...problem, name: undefined });
          }}
        />
        <span className={problem.name ? "hint error" : "hint"}>
          {problem.name ??
            (preview
              ? `Its address: ${preview}`
              : "A short name for its address, for example seat.")}
        </span>
      </label>
      <p className="muted small">
        Only you can talk to it. If it offers shares, you can give them to people on its card.
      </p>
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
