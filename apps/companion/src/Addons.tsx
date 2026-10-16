// The Add-ons tab (docs/add-ons.md): services that serve live voice over a call, linked to your
// account, and the shares of other people's add-ons given to you. Each linked add-on has a page
// that says what it does (from what it said about itself, `addon.about`), with Call, Add to
// contacts and Put on a key; each of its shares has the same, plus Give to…. Nothing here knows
// any particular add-on. Online/offline is what the server reports.
import { type FormEvent, useCallback, useEffect, useState } from "react";
import {
  aboutLines,
  addonAddressProblem,
  addonNameProblem,
  addonPreview,
  addonStatus,
  addonTestText,
  type GoneNote,
  goneText,
  heldShareLabel,
  learnsText,
  linkedText,
  removalText,
  shareRequestText,
  stoppedText,
} from "./addonText.ts";
import type {
  AddonContact,
  AddonPerson,
  AddonShareView,
  AddonTestResult,
  AddonView,
  Api,
  DeviceSummary,
  HeldShare,
  ShareRequestView,
} from "./api.ts";
import type { Connection } from "./connection.ts";
import { PutOnKey } from "./PutOnKey.tsx";
import { formatWhen } from "./text.ts";

/** How often the list is read again while it's open (online/offline as the server says). */
const REFRESH_MS = 15_000;

/** A share of someone else's add-on given to you: on this server, or by a connection's server. */
interface Held {
  key: string;
  /** "Jo's echo · Book club". */
  title: string;
  /** The add-on's name. */
  addon: string;
  /** Whose add-on it is (their name). */
  ownerName: string;
  shareLabel: string;
  address: string;
  muted: boolean;
  about?: HeldShare["about"] | undefined;
  stopped?: HeldShare["stopped"];
  goneId?: string | undefined;
}

type View = { name: "list" } | { name: "addon"; id: string } | { name: "link" };

/** `handle+name+share@host` → `handle+name@host`. */
const withoutShare = (address: string) => address.replace(/^([^+@]+\+[^+@]+)\+[^@]*@/, "$1@");

/** `jo+echo+bookclub@host` → `echo`. */
const nameOf = (address: string) => address.split("@")[0]?.split("+")[1] ?? address;

export function Addons({
  api,
  conn,
  address,
  devices,
  meId,
  onBack,
}: {
  api: Api;
  conn: Connection | undefined;
  /** Your own address (`handle@host`), for the new add-on's address. */
  address: string | undefined;
  /** Phones of the active space (your own phones get keys). */
  devices: DeviceSummary[];
  meId: string | undefined;
  onBack(): void;
}) {
  const [info, setInfo] = useState<{ enabled: boolean; addons: AddonView[] }>();
  const [held, setHeld] = useState<Held[]>([]);
  const [contacts, setContacts] = useState<AddonContact[]>([]);
  /** What went (removed add-ons, shares gone), until dismissed. */
  const [gone, setGone] = useState<GoneNote[]>([]);
  const [people, setPeople] = useState<AddonPerson[]>([]);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [view, setView] = useState<View>();
  /** Just linked: its page opens with Put on a key ready. */
  const [justLinked, setJustLinked] = useState<string>();

  const load = useCallback(() => {
    Promise.all([
      api.addons(),
      api.addonsShared().catch(() => ({ held: [] as HeldShare[] })),
      api.addonContacts().catch(() => [] as AddonContact[]),
      api.addonsGone().catch(() => [] as GoneNote[]),
    ]).then(
      ([mine, shared, cs, g]) => {
        setInfo(mine);
        setGone(g);
        setHeld(shared.held.map(heldView));
        setContacts(cs);
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

  // One add-on of your own and nothing shared with you: its page is the tab.
  const only = info && info.addons.length === 1 && held.length === 0 ? info.addons[0] : undefined;
  const current: View = view ?? (only ? { name: "addon", id: only.id } : { name: "list" });
  const inContacts = new Set(contacts.map((c) => c.address));
  const toggleContact = async (addr: string, label: string) => {
    try {
      if (inContacts.has(addr)) {
        await api.removeAddonContact(addr);
        setNotice(`${label} is no longer in your contacts.`);
      } else {
        await api.addAddonContact(addr, label);
        setNotice(`${label} is in your contacts on Home.`);
      }
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const shared: Shared = {
    api,
    conn,
    devices,
    meId,
    people,
    enabled: info?.enabled ?? false,
    inContacts,
    onContact: toggleContact,
    onChanged: load,
    onNotice: setNotice,
    onError: setError,
  };

  const page = current.name === "addon" ? info?.addons.find((a) => a.id === current.id) : undefined;
  const top = current.name === "list" || (page !== undefined && page === only);

  return (
    <section className="stack addons-tab">
      <button
        type="button"
        className="link back"
        onClick={() => (top ? onBack() : setView({ name: "list" }))}
      >
        ← {top ? "Back" : "All add-ons"}
      </button>
      <h2>
        {page ? page.name : current.name === "link" ? "Link an add-on" : "Add-ons"}
        {page && (
          <>
            {" "}
            <span className="badge">add-on</span>
          </>
        )}
      </h2>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      {info && !info.enabled && (
        <p className="card muted" role="status">
          This server doesn't offer add-ons. Its operator can turn them on.
          {info.addons.length > 0 &&
            " Until then, your add-ons can't connect and nobody can call them."}
        </p>
      )}
      {!info && !error && <p className="muted">Loading…</p>}
      {gone.length > 0 && (
        <ul className="stack gone-notes">
          {gone.map((n) => (
            <li key={n.id} className="notice row wrap" role="status">
              <span className="grow">{goneText(n)}</span>
              <button
                type="button"
                className="link"
                onClick={() => void api.dismissAddonGone(n.id).then(load, load)}
              >
                OK
              </button>
            </li>
          ))}
        </ul>
      )}

      {current.name === "link" && info?.enabled && (
        <LinkForm
          api={api}
          address={address}
          onDone={(a) => {
            setNotice(`Linked. ${a.name} is at ${a.address}.`);
            setJustLinked(a.id);
            setView({ name: "addon", id: a.id });
            load();
          }}
          onCancel={() => setView(undefined)}
        />
      )}

      {page && (
        <AddonPage
          key={page.id}
          addon={page}
          {...shared}
          keyFirst={justLinked === page.id}
          onRemoved={() => {
            setView({ name: "list" });
            load();
          }}
        />
      )}
      {page && page === only && info?.enabled && (
        <div className="row">
          <button type="button" className="link" onClick={() => setView({ name: "link" })}>
            Link another add-on
          </button>
        </div>
      )}

      {current.name === "list" && info && (
        <>
          <p className="hint">
            An add-on is a service you call like a person: an assistant, a radio, a notes taker.
            Linking one gives it an address on your account; only you can call it there. If it
            offers parts of itself to share, you choose who gets each part.
          </p>
          {info.addons.length === 0 && held.length > 0 && <HeldList held={held} {...shared} />}
          {info.addons.length === 0 && info.enabled && held.length === 0 && (
            <div className="card stack">
              <h3>No add-ons yet</h3>
              <p className="muted small">
                Start linking in the service: it asks for this server's address,{" "}
                <code>{location.host}</code>, and shows a 6-digit code.
              </p>
            </div>
          )}
          {info.addons.length > 0 && (
            <ul className="stack addon-list">
              {info.addons.map((a) => (
                <li key={a.id} className="card addon-card">
                  <button
                    type="button"
                    className="addon-open"
                    onClick={() => setView({ name: "addon", id: a.id })}
                  >
                    <span className="row">
                      <span className={`dot ${a.online ? "on" : "off"}`} aria-hidden />
                      <strong>{a.name}</strong> <span className="badge">add-on</span>
                    </span>
                    <span className="muted small">
                      {a.about?.summary ??
                        addonStatus(a, info.enabled, (t) => formatWhen(t, Date.now()))}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {info.enabled && (
            <div className="row">
              <button type="button" className="primary" onClick={() => setView({ name: "link" })}>
                Link an add-on
              </button>
            </div>
          )}
          {info.addons.length > 0 && <HeldList held={held} {...shared} />}
          <CallByAddress onCall={(addr) => void conn?.callAddon(addr, nameOf(addr))} />
          <p className="hint">
            An add-on linked to your account on another server shows on that server's app. To reach
            it from here, connect your two accounts (Connections), then on the other server give
            this account a share of it.
          </p>
        </>
      )}
    </section>
  );
}

/** Owner names from the server's note ("Jesse (jesse@a.test)") are shown as they come. */
const heldView = (h: HeldShare): Held => ({
  key: h.key,
  title: heldShareLabel(h.owner.name, h.addon, h.share.label),
  addon: h.addon,
  ownerName: h.owner.name,
  shareLabel: h.share.label,
  address: h.address,
  muted: !!h.muted,
  about: h.about,
  stopped: h.stopped,
  goneId: h.goneId,
});

interface Shared {
  api: Api;
  conn: Connection | undefined;
  devices: DeviceSummary[];
  meId: string | undefined;
  people: AddonPerson[];
  enabled: boolean;
  inContacts: Set<string>;
  onContact(address: string, label: string): Promise<void>;
  onChanged(): void;
  onNotice(text: string): void;
  onError(text: string): void;
}

/** Call, Add to contacts and Put on a key: the same three for an add-on, a share, a held share. */
function ReachActions({
  address,
  label,
  shareLabel,
  noKeys,
  canCall,
  callNote,
  keyOpen: keyFirst,
  ...s
}: Shared & {
  address: string;
  label: string;
  shareLabel?: string | undefined;
  noKeys?: boolean | undefined;
  canCall: boolean;
  /** Why Call can't be used now, said next to it. */
  callNote?: string | undefined;
  keyOpen?: boolean | undefined;
}) {
  const [keyOpen, setKeyOpen] = useState(keyFirst ?? false);
  const listed = s.inContacts.has(address.toLowerCase());
  return (
    <div className="stack">
      <div className="row wrap">
        <button
          type="button"
          className="primary"
          disabled={!canCall || !s.conn}
          onClick={() => void s.conn?.callAddon(address, label, noKeys ? { keys: false } : {})}
        >
          Call
        </button>
        <button type="button" onClick={() => void s.onContact(address.toLowerCase(), label)}>
          {listed ? "Remove from contacts" : "Add to contacts"}
        </button>
        {!keyOpen && (
          <button type="button" onClick={() => setKeyOpen(true)}>
            Put on a key
          </button>
        )}
      </div>
      {!canCall && callNote && <span className="hint">{callNote}</span>}
      {keyOpen && (
        <PutOnKey
          api={s.api}
          devices={s.devices}
          meId={s.meId}
          address={address}
          label={label}
          shareLabel={shareLabel}
          onDone={(text) => {
            setKeyOpen(false);
            s.onNotice(text);
          }}
          onCancel={() => setKeyOpen(false)}
        />
      )}
    </div>
  );
}

function AddonPage({
  addon,
  keyFirst,
  onRemoved,
  ...s
}: Shared & { addon: AddonView; keyFirst: boolean; onRemoved(): void }) {
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const status = addonStatus(addon, s.enabled, (t) => formatWhen(t, Date.now()));
  const about = addon.about ?? null;
  const rules = addon.rules ?? { answers: true, calls: true, shares: true, keys: true, lines: 1 };
  const copy = (text: string) =>
    void navigator.clipboard?.writeText(text).then(
      () => s.onNotice("Address copied."),
      () => s.onError("Couldn't copy; select it instead."),
    );
  const act = async (work: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    try {
      await work();
      if (done) s.onNotice(done);
      s.onChanged();
    } catch (e) {
      s.onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (
      !window.confirm(`Remove ${addon.name}? ${removalText(addon)} To use it again, link it again.`)
    ) {
      return;
    }
    await act(() => s.api.removeAddon(addon.id));
    onRemoved();
  };
  const callNote = !s.enabled
    ? "Add-ons are off on this server."
    : !rules.answers
      ? `${addon.name} doesn't take calls.`
      : undefined;
  return (
    <div className="stack addon-page">
      <div className="card stack">
        <div className="row wrap">
          <span className={`dot ${addon.online ? "on" : "off"}`} aria-hidden />
          <span>{status}</span>
        </div>
        <div className="row wrap">
          <code className="small">{addon.address}</code>
          <button type="button" className="link" onClick={() => copy(addon.address)}>
            Copy
          </button>
        </div>
        <p className="muted small">{linkedText(addon)} Only you can call it at this address.</p>
        {s.enabled && <TestConnection run={() => s.api.testAddon(addon.id)} />}
        <ReachActions
          {...s}
          address={addon.address}
          label={addon.name}
          noKeys={!rules.keys}
          canCall={s.enabled && rules.answers}
          callNote={callNote}
          keyOpen={keyFirst}
        />
      </div>

      <div className="card stack">
        <h3>What it does</h3>
        {about?.summary && <p>“{about.summary}”</p>}
        <ul className="plain-list">
          {aboutLines(about, addon.name).map((line) => (
            <li key={line}>{line}</li>
          ))}
          <li>It learns the name and address of whoever calls it.</li>
        </ul>
        <p className="muted small">
          {about
            ? "In its own words. Whether it takes calls, calls you, offers shares and takes keys is held to by the server; what it does with what it hears happens inside it."
            : "Until it says, it may do what add-ons can: be called, call you, offer shares and hear keys."}
        </p>
      </div>

      {addon.allowNote && (
        <div className="notice row wrap" role="status">
          <span>
            The people you had let talk to {addon.name} were removed. Give someone one of its shares
            below instead.
          </span>
          <button
            type="button"
            className="link"
            onClick={() => void act(() => s.api.dismissAddonNote(addon.id))}
          >
            OK
          </button>
        </div>
      )}

      <div className="card stack">
        <h3>Shares</h3>
        {addon.shares.length === 0 ? (
          <p className="muted small">
            {rules.shares
              ? `${addon.name} doesn't offer anything to share yet. When it does, its shares show up here and you choose who gets each.`
              : `${addon.name} doesn't offer parts of itself to share.`}
          </p>
        ) : (
          <ul className="stack addon-shares">
            {addon.shares.map((sh) => (
              <ShareRow
                key={sh.id}
                addon={addon}
                share={sh}
                busy={busy}
                noKeys={!rules.keys}
                canCall={s.enabled && rules.answers}
                callNote={callNote}
                onCopy={copy}
                onGive={(ref, name) =>
                  act(
                    () => s.api.giveShare(addon.id, sh.id, ref),
                    `${sh.label} is shared with ${name}.`,
                  )
                }
                onRevoke={(h) => {
                  if (
                    !window.confirm(
                      `Take ${sh.label} back from ${h.name}? A call of theirs into it ends now.`,
                    )
                  ) {
                    return;
                  }
                  void act(
                    () => s.api.revokeShare(addon.id, h.grantId),
                    `${h.name} no longer has ${sh.label}.`,
                  );
                }}
                {...s}
              />
            ))}
          </ul>
        )}
        {rules.shares &&
          (asking ? (
            <NewShareForm
              addon={addon}
              api={s.api}
              people={s.people}
              onClose={() => {
                setAsking(false);
                s.onChanged();
              }}
              onChanged={s.onChanged}
            />
          ) : (
            <div className="row">
              <button type="button" disabled={!s.enabled} onClick={() => setAsking(true)}>
                Ask it for a new share…
              </button>
            </div>
          ))}
      </div>

      <div className="card stack">
        <p className="muted small">
          Linked in {addon.space}
          {addon.fw ? ` · runs ${addon.fw}` : ""}. Its calls count as yours.
        </p>
        <div className="row">
          <button type="button" className="danger" disabled={busy} onClick={() => void remove()}>
            Remove {addon.name}
          </button>
        </div>
      </div>
    </div>
  );
}

/** One share: its address, who holds it (Revoke), Call / Add to contacts / Put on a key, Give to…. */
function ShareRow({
  addon,
  share,
  busy,
  noKeys,
  canCall,
  callNote,
  onCopy,
  onGive,
  onRevoke,
  ...s
}: Shared & {
  addon: AddonView;
  share: AddonShareView;
  busy: boolean;
  noKeys: boolean;
  canCall: boolean;
  callNote: string | undefined;
  onCopy(text: string): void;
  onGive(ref: string, name: string): Promise<void>;
  onRevoke(h: AddonShareView["holders"][number]): void;
}) {
  const [giving, setGiving] = useState(false);
  const [choice, setChoice] = useState("");
  const holding = new Set(share.holders.map((h) => h.address));
  const free = s.people.filter((p) => !holding.has(p.address));
  const chosen = free.find((p) => p.ref === choice);
  return (
    <li className="stack share">
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
      <ReachActions
        {...s}
        address={share.address}
        label={`${addon.name} · ${share.label}`}
        shareLabel={share.label}
        noKeys={noKeys}
        canCall={canCall}
        callNote={callNote}
      />
      {giving ? (
        <div className="stack give">
          <label>
            Give {share.label} to
            <select value={choice} onChange={(e) => setChoice(e.target.value)}>
              <option value="">Choose someone…</option>
              {free.map((p) => (
                <option key={p.ref} value={p.ref}>
                  {p.name} ({p.address})
                </option>
              ))}
            </select>
          </label>
          {free.length === 0 && (
            <span className="hint">
              Nobody else to give it to: connect with someone first, or invite them to one of your
              spaces.
            </span>
          )}
          <span className="hint">
            {chosen
              ? learnsText(addon.name, chosen.name)
              : `When someone calls, ${addon.name} learns their name and address, and can hear what they say.`}{" "}
            They can call this address and {share.label} only, and {addon.name} can call them within
            it.
          </span>
          <div className="row">
            <button
              type="button"
              className="primary"
              disabled={!choice || busy}
              onClick={() => {
                void onGive(choice, chosen?.name ?? "them").then(() => {
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
          </div>
        </div>
      ) : (
        <div className="row">
          <button type="button" disabled={!s.enabled} onClick={() => setGiving(true)}>
            Give to…
          </button>
        </div>
      )}
    </li>
  );
}

/** Test connection: asks the add-on (no call) and says how it went. */
function TestConnection({ run }: { run(): Promise<AddonTestResult> }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string>();
  return (
    <div className="row wrap">
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setResult(undefined);
          run()
            .then(
              (r) => setResult(addonTestText(r)),
              (e: Error) => setResult(e.message),
            )
            .finally(() => setBusy(false));
        }}
      >
        {busy ? "Testing…" : "Test connection"}
      </button>
      {result && (
        <span className="small" role="status">
          {result}
        </span>
      )}
    </div>
  );
}

/** Shares of other people's add-ons given to you, with what you control. */
function HeldList({ held, ...s }: Shared & { held: Held[] }) {
  if (!held.length) return null;
  return (
    <div className="stack">
      <h3>Shared with you</h3>
      <ul className="stack">
        {held.map((h) => (
          <HeldRow key={h.key} h={h} {...s} />
        ))}
      </ul>
    </div>
  );
}

function HeldRow({ h, ...s }: Shared & { h: Held }) {
  const act = async (work: () => Promise<unknown>, done: string) => {
    try {
      await work();
      s.onNotice(done);
      s.onChanged();
    } catch (e) {
      s.onError((e as Error).message);
    }
  };
  const giveBack = () => {
    if (h.goneId) {
      void act(
        () => s.api.dismissAddonGone(h.goneId as string),
        `${h.shareLabel} is off your list.`,
      );
      return;
    }
    if (
      !window.confirm(
        `Give ${h.shareLabel} back? You can't call it any more, and it can't call you within it.`,
      )
    ) {
      return;
    }
    void act(() => s.api.leaveShare(h.address), `You gave ${h.shareLabel} back.`);
  };
  if (h.stopped) {
    return (
      <li className="card stack held stopped">
        <div className="row wrap">
          <strong>{h.title}</strong> <span className="badge">add-on</span>
        </div>
        {h.address && <code className="small">{h.address}</code>}
        <p className="warning small" role="status">
          {stoppedText(h.stopped, h.ownerName)}
        </p>
        <div className="row wrap">
          <button type="button" className="danger" onClick={giveBack}>
            Give it back
          </button>
        </div>
      </li>
    );
  }
  return (
    <li className="card stack held">
      <div className="row wrap">
        <strong>{h.title}</strong> <span className="badge">add-on</span>
      </div>
      <code className="small">{h.address}</code>
      {h.about && (
        <ul className="plain-list small">
          {aboutLines(h.about, h.addon).map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
      <p className="hint">{learnsText(h.addon)}</p>
      {s.enabled && <TestConnection run={() => s.api.testShare(h.address)} />}
      <ReachActions
        {...s}
        address={h.address}
        label={`${h.addon} · ${h.shareLabel}`}
        shareLabel={h.shareLabel}
        canCall={s.enabled}
        callNote={s.enabled ? undefined : "Add-ons are off on this server."}
      />
      {h.muted && (
        <p className="muted small" role="status">
          You stopped its calls. You can still call it.
        </p>
      )}
      <div className="row wrap">
        <button
          type="button"
          aria-pressed={h.muted}
          onClick={() =>
            void act(
              () => s.api.muteAddon(withoutShare(h.address), !h.muted),
              h.muted
                ? `${h.addon} may call you again.`
                : `${h.addon} can't call you now. You can still call it.`,
            )
          }
        >
          {h.muted ? "Let it call me" : "Stop its calls"}
        </button>
        <button type="button" className="danger" onClick={giveBack}>
          Give it back
        </button>
      </div>
    </li>
  );
}

/** Someone's add-on, or a share of one given to you: call it by its address. */
function CallByAddress({ onCall }: { onCall(address: string): void }) {
  const [to, setTo] = useState("");
  const [problem, setProblem] = useState<string>();
  return (
    <form
      className="card stack"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        const p = addonAddressProblem(to);
        setProblem(p);
        if (!p) onCall(to.trim().toLowerCase());
      }}
    >
      <h3>Call an add-on by its address</h3>
      <label>
        Its address
        <input
          value={to}
          inputMode="email"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          aria-invalid={problem ? true : undefined}
          onChange={(e) => {
            setTo(e.target.value);
            setProblem(undefined);
          }}
        />
        <span className={problem ? "hint error" : "hint"}>
          {problem ?? "Like name+radio@example.org, or name+radio+part@example.org for a share."}
        </span>
      </label>
      <div className="row">
        <button type="submit">Call</button>
      </div>
    </form>
  );
}

/** How often a share request is read again while the add-on hasn't answered. */
const REQUEST_POLL_MS = 1_000;

/** "Ask it for a new share…": a name and people; the add-on makes it, then they get it. */
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
    if (request?.state !== "waiting") {
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
      setProblem("Give it a name.");
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
      <h4>Ask it for a new share</h4>
      <p className="hint">
        {addon.name} decides what a share is and makes it. Then the people you choose can call it at
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
    <form className="card stack" noValidate onSubmit={(e) => void submit(e)}>
      <ol className="addon-steps">
        <li>
          In the service, choose to connect it to Open Lounge Phone and give it this server's
          address: <code>{location.host}</code>{" "}
          <button
            type="button"
            className="link"
            onClick={() => void navigator.clipboard?.writeText(location.host)}
          >
            Copy
          </button>
        </li>
        <li>It shows a 6-digit code for a few minutes. Type it here, and give it a name.</li>
      </ol>
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
          autoCapitalize="none"
          aria-invalid={problem.name ? true : undefined}
          onChange={(e) => {
            setName(e.target.value);
            setProblem({ ...problem, name: undefined });
          }}
        />
        <span className={problem.name ? "hint error" : "hint"}>
          {problem.name ??
            (preview ? `Its address: ${preview}` : "A short name for its address, like radio.")}
        </span>
      </label>
      <p className="muted small">
        Only you can call it. If it offers parts of itself to share, you choose who gets them on its
        page.
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

/** Home: the add-ons (and shares) you put in your contacts, one tap to call. */
export function AddonContactsCard({
  api,
  conn,
  refreshKey,
  onAddons,
}: {
  api: Api;
  conn: Connection | undefined;
  refreshKey: number;
  onAddons(): void;
}) {
  const [list, setList] = useState<AddonContact[]>([]);
  useEffect(() => {
    void refreshKey;
    api.addonContacts().then(setList, () => {});
  }, [api, refreshKey]);
  if (!list.length) return null;
  return (
    <section className="card stack addon-contacts">
      <h3>Contacts</h3>
      <ul className="stack">
        {list.map((c) => (
          <li key={c.address} className="row wrap">
            <span className="grow">
              {c.label} <span className="badge">add-on</span>
              {!c.ok && <span className="muted small block">Can't be called now.</span>}
            </span>
            <button
              type="button"
              className="primary"
              disabled={!c.ok || !conn}
              onClick={() => void conn?.callAddon(c.address, c.label)}
            >
              Call
            </button>
          </li>
        ))}
      </ul>
      <button type="button" className="link" onClick={onAddons}>
        Manage in Add-ons
      </button>
    </section>
  );
}
