import { useCallback, useEffect, useState } from "react";
import {
  type AccountInfo,
  type Api,
  errorCode,
  type Me,
  type Membership,
  type PasskeySummary,
  type SessionSummary,
  type User,
} from "./api.ts";
import { AvailabilityToggle } from "./GrownUps.tsx";
import { YourHouseholds } from "./Households.tsx";
import { Credit, FairUseCard, FundingCard } from "./HubCards.tsx";
import { handleHint, normalizeHandle } from "./handles.ts";
import { PasskeyHelp, PasskeysUnavailable } from "./PasskeyHelp.tsx";
import {
  defaultPasskeyName,
  passkeyErrorText,
  passkeysSupported,
  registerPasskey,
} from "./passkeys.ts";
import { ShowRecoveryCode } from "./RecoveryCode.tsx";
import { roleNoun, type SpaceType, spaceNoun } from "./spaces.ts";
import { formatWhen } from "./text.ts";

interface Props {
  api: Api;
  me: User | undefined;
  /** Everything `/me` says (session, recovery code, owner, what this server allows). */
  info: Me;
  spaceType: SpaceType | undefined;
  available: boolean;
  onAvailable(v: boolean): void;
  onBack(): void;
  onSignOut(): void;
  onHelp(): void;
  account: AccountInfo | undefined;
  memberships: Membership[];
  onSwitch(householdId: string): void;
  onAddHousehold(): void;
  onAccountChanged(): void;
  /** Left a space: reload everything. */
  onLeft(): void;
  /** People page (to hand a space on). */
  onPeople(): void;
}

/** How a session started, in words. */
const VIA: Record<string, string> = {
  passkey: "a passkey",
  signup: "a passkey (new account)",
  setup: "the setup link",
  invite: "an invite",
  link: "a sign-in link",
  recovery: "the recovery code",
};

export function Account({
  api,
  me,
  info,
  spaceType,
  available,
  onAvailable,
  onBack,
  onSignOut,
  onHelp,
  account,
  memberships,
  onSwitch,
  onAddHousehold,
  onAccountChanged,
  onLeft,
  onPeople,
}: Props) {
  const role = me
    ? info.owner
      ? `Owner of this ${spaceNoun(spaceType)}`
      : `${roleNoun(me.role, spaceType)} in this ${spaceNoun(spaceType)}`
    : undefined;

  return (
    <section className="stack">
      <button type="button" className="link back" onClick={onBack}>
        ← Back
      </button>
      <h2>{me ? me.name : (account?.name ?? "Account")}</h2>
      {me && <AvailabilityToggle available={available} onChange={onAvailable} />}
      {role && <p className="muted">{role}</p>}

      {account && <AddressCard api={api} account={account} onChanged={onAccountChanged} />}
      {account && <NameCard api={api} account={account} onChanged={onAccountChanged} />}

      <YourHouseholds
        memberships={memberships}
        activeId={me?.householdId}
        onSwitch={onSwitch}
        onAdd={onAddHousehold}
        canAdd={info.canAddSpace !== false}
      />

      <Passkeys
        api={api}
        hasRecoveryCode={info.recoveryCode === true}
        onChanged={onAccountChanged}
      />
      {account && (
        <RecoveryCard
          api={api}
          address={account.address}
          has={info.recoveryCode === true}
          onChanged={onAccountChanged}
        />
      )}
      <Sessions api={api} onSignOut={onSignOut} />

      <FairUseCard api={api} />
      <FundingCard api={api} />

      <h3>Help</h3>
      <button type="button" onClick={onHelp}>
        What's what — plain-language guide
      </button>

      <h3>Session</h3>
      <button type="button" onClick={onSignOut}>
        Sign out of this device
      </button>
      {me && (
        <LeaveSpace
          api={api}
          owner={info.owner === true}
          spaceType={spaceType}
          spaceName={memberships.find((m) => m.householdId === me.householdId)?.householdName}
          onlySpace={memberships.length <= 1}
          onLeft={onLeft}
          onPeople={onPeople}
        />
      )}
      {account && <LeaveCard api={api} handle={account.handle} onDeleted={onSignOut} />}
      <Credit />
    </section>
  );
}

/** Your passkeys: add one; remove one (confirmed; the last only with a recovery code). */
function Passkeys({
  api,
  hasRecoveryCode,
  onChanged,
}: {
  api: Api;
  hasRecoveryCode: boolean;
  onChanged(): void;
}) {
  const [passkeys, setPasskeys] = useState<PasskeySummary[]>([]);
  const [name, setName] = useState(() => defaultPasskeyName(navigator.userAgent));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [confirm, setConfirm] = useState<string>();
  /** Just removed one: offer to sign out everywhere else. */
  const [offerSignOut, setOfferSignOut] = useState(false);
  const supported = passkeysSupported();

  const load = useCallback(async () => {
    try {
      setPasskeys(await api.passkeys());
    } catch (e) {
      setError((e as Error).message);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const add = async () => {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      await registerPasskey(api, name.trim() || "Passkey");
      setNotice("Passkey added. Next time, choose “Sign in with a passkey”.");
      onChanged();
    } catch (e) {
      setError(passkeyErrorText(e));
    } finally {
      setBusy(false);
      await load();
    }
  };

  const remove = async (id: string) => {
    setError(undefined);
    setConfirm(undefined);
    try {
      await api.removePasskey(id);
      setOfferSignOut(true);
      onChanged();
    } catch (e) {
      setError(
        errorCode(e) === "last_passkey"
          ? "This is your last passkey. Make a recovery code first (below), or add another passkey, so you can still get in."
          : (e as Error).message,
      );
    }
    await load();
  };

  const signOutOthers = async () => {
    setOfferSignOut(false);
    try {
      const { signedOut } = await api.signOutOthers();
      setNotice(
        signedOut === 0
          ? "You weren't signed in anywhere else."
          : `Signed out on ${signedOut} other ${signedOut === 1 ? "device" : "devices"}.`,
      );
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const now = Date.now();
  const last = passkeys.length === 1;

  return (
    <>
      <h3>Your passkeys</h3>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {notice && <p className="ok">{notice}</p>}
      {offerSignOut && (
        <div className="card stack">
          <p>
            Removing a passkey doesn't sign anyone out. If a device with it was lost or someone else
            might have it, sign out everywhere else too.
          </p>
          <div className="row">
            <button type="button" className="danger" onClick={() => void signOutOthers()}>
              Sign out everywhere else
            </button>
            <button type="button" className="link" onClick={() => setOfferSignOut(false)}>
              Not now
            </button>
          </div>
        </div>
      )}
      {passkeys.length === 0 && (
        <p className="muted">
          No passkeys yet. Without one, you'll need your recovery code or a new sign-in link once
          you're signed out.
        </p>
      )}
      {last && (
        <p className="muted">
          Add a second passkey on another device or a security key, so losing this one doesn't lock
          you out.
        </p>
      )}
      <ul className="stack">
        {passkeys.map((p) => (
          <li key={p.id} className="card person">
            <div>
              <div className="device-name">{p.name}</div>
              <div className="muted small">
                Added {formatWhen(p.createdAt, now)}
                {p.lastUsedAt ? ` · last used ${formatWhen(p.lastUsedAt, now)}` : ""}
              </div>
            </div>
            {confirm === p.id ? (
              <div className="stack">
                {last && (
                  <p className="warning small">
                    {hasRecoveryCode
                      ? "This is your last passkey. Without it, you'll need your recovery code to sign in again."
                      : "This is your last passkey, and you have no recovery code: make one first."}
                  </p>
                )}
                <div className="row">
                  <button
                    type="button"
                    className="danger"
                    disabled={last && !hasRecoveryCode}
                    onClick={() => void remove(p.id)}
                  >
                    Remove {p.name}
                  </button>
                  <button type="button" className="link" onClick={() => setConfirm(undefined)}>
                    Keep
                  </button>
                </div>
              </div>
            ) : (
              <button type="button" className="danger" onClick={() => setConfirm(p.id)}>
                Remove
              </button>
            )}
          </li>
        ))}
      </ul>
      {supported ? (
        <div className="card stack">
          <label>
            Name for the new passkey
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} />
          </label>
          <button type="button" className="primary" disabled={busy} onClick={() => void add()}>
            {busy ? "Waiting for your device…" : "Add a passkey"}
          </button>
          <PasskeyHelp />
        </div>
      ) : (
        <PasskeysUnavailable />
      )}
    </>
  );
}

/** Account → Recovery code: whether you have one, and making a new one (shown once). */
function RecoveryCard({
  api,
  address,
  has,
  onChanged,
}: {
  api: Api;
  address: string;
  has: boolean;
  onChanged(): void;
}) {
  const [code, setCode] = useState<string>();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string>();
  const make = async () => {
    setError(undefined);
    setConfirming(false);
    try {
      setCode((await api.newRecoveryCode()).code);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="card stack" id="recovery-code">
      <h3>Recovery code</h3>
      {code ? (
        <ShowRecoveryCode
          code={code}
          address={address}
          doneLabel="I saved it"
          onDone={() => {
            setCode(undefined);
            onChanged();
          }}
        />
      ) : (
        <>
          <p className="muted small">
            {has
              ? "You have a recovery code. With your handle, it gets you back in if every passkey is lost. Making a new one stops the old one working."
              : "You don't have a recovery code yet. Make one, so you can get back in if you lose your passkeys."}
          </p>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          {has && !confirming ? (
            <button type="button" onClick={() => setConfirming(true)}>
              Make a new recovery code
            </button>
          ) : has ? (
            <div className="row">
              <button type="button" className="primary" onClick={() => void make()}>
                Replace my recovery code
              </button>
              <button type="button" className="link" onClick={() => setConfirming(false)}>
                Cancel
              </button>
            </div>
          ) : (
            <button type="button" className="primary" onClick={() => void make()}>
              Make a recovery code
            </button>
          )}
        </>
      )}
    </div>
  );
}

/** Where you're signed in: each session, Sign out on each, and "Sign out everywhere else". */
function Sessions({ api, onSignOut }: { api: Api; onSignOut(): void }) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [error, setError] = useState<string>();
  const load = useCallback(async () => {
    try {
      setSessions(await api.sessions());
    } catch (e) {
      setError((e as Error).message);
    }
  }, [api]);
  useEffect(() => {
    void load();
  }, [load]);
  const end = async (s: SessionSummary) => {
    setError(undefined);
    try {
      await api.endSession(s.id);
      if (s.current) {
        onSignOut();
        return;
      }
    } catch (e) {
      setError((e as Error).message);
    }
    await load();
  };
  const others = async () => {
    setError(undefined);
    try {
      await api.signOutOthers();
    } catch (e) {
      setError((e as Error).message);
    }
    await load();
  };
  const now = Date.now();
  return (
    <>
      <h3>Where you're signed in</h3>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <ul className="stack">
        {sessions.map((s) => (
          <li key={s.id} className="card person">
            <div>
              <div className="device-name">
                {s.label ?? "A browser or app"}
                {s.current && <span className="muted small"> (this device)</span>}
              </div>
              <div className="muted small">
                Signed in {formatWhen(s.createdAt, now)}
                {s.via ? ` with ${VIA[s.via] ?? s.via}` : ""}
                {s.lastUsedAt ? ` · last used ${formatWhen(s.lastUsedAt, now)}` : ""}
                {!s.passkey && ` · signs out ${formatWhen(s.expiresAt, now)}`}
              </div>
            </div>
            <button type="button" onClick={() => void end(s)}>
              Sign out
            </button>
          </li>
        ))}
      </ul>
      {sessions.length > 1 && (
        <button type="button" className="danger" onClick={() => void others()}>
          Sign out everywhere else
        </button>
      )}
    </>
  );
}

/** Leave the active space (the owner hands it on first; an only space goes with the account). */
function LeaveSpace({
  api,
  owner,
  spaceType,
  spaceName,
  onlySpace,
  onLeft,
  onPeople,
}: {
  api: Api;
  owner: boolean;
  spaceType: SpaceType | undefined;
  spaceName: string | undefined;
  onlySpace: boolean;
  onLeft(): void;
  onPeople(): void;
}) {
  const [members, setMembers] = useState<number>();
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string>();
  const noun = spaceNoun(spaceType);
  const name = spaceName ?? `this ${noun}`;
  useEffect(() => {
    api.users().then(
      (u) => setMembers(u.length),
      () => {},
    );
  }, [api]);
  const leave = async () => {
    setError(undefined);
    try {
      await api.leaveSpace();
      onLeft();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  if (members === undefined) return null;
  const alone = members <= 1;
  return (
    <details className="card stack leave">
      <summary>Leave {name}</summary>
      {owner && !alone ? (
        <>
          <p className="small muted">
            You own {name}. To leave, first hand it to another{" "}
            {spaceType === "home" || !spaceType ? "guardian" : "admin"} on the People page.
          </p>
          <button type="button" onClick={onPeople}>
            Go to People
          </button>
        </>
      ) : onlySpace ? (
        <p className="small muted">
          This is your only {noun} here. To leave it, delete your account below.
        </p>
      ) : (
        <>
          <p className="small muted">
            {owner
              ? `You're the only one in ${name}, so leaving deletes it, with its phones and voicemail.`
              : `You'll no longer be in ${name}: its phones stop showing you, and its people can't call you there. Your other spaces and your account stay.`}
          </p>
          {confirm ? (
            <div className="row">
              <button type="button" className="danger" onClick={() => void leave()}>
                {owner ? `Leave and delete ${name}` : `Leave ${name}`}
              </button>
              <button type="button" className="link" onClick={() => setConfirm(false)}>
                Stay
              </button>
            </div>
          ) : (
            <button type="button" className="danger" onClick={() => setConfirm(true)}>
              Leave {name}
            </button>
          )}
        </>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </details>
  );
}

/** Your address (`handle@host`) and changing the handle (the server allows once a day). */
function AddressCard({
  api,
  account,
  onChanged,
}: {
  api: Api;
  account: AccountInfo;
  onChanged(): void;
}) {
  const [editing, setEditing] = useState(false);
  const [handle, setHandle] = useState(account.handle);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  /** Show what's wrong in red once they tried to save (before that, it's guidance). */
  const [showHint, setShowHint] = useState(false);
  const host = account.address.slice(account.address.indexOf("@") + 1);
  const hint = handleHint(handle);

  const save = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await api.updateAccount({ handle });
      setEditing(false);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card stack">
      <div>
        <div className="muted small">Your address</div>
        <div className="device-name address">{account.address}</div>
      </div>
      {editing ? (
        <form
          className="stack"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            setShowHint(true);
            if (!hint) void save();
          }}
        >
          <label>
            Handle
            <input
              value={handle}
              onChange={(e) => setHandle(normalizeHandle(e.target.value))}
              maxLength={30}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              aria-invalid={hint && showHint ? true : undefined}
            />
            <span className={hint && showHint ? "hint error" : "hint"}>
              {hint ?? `${handle}@${host} · you can change it once a day`}
            </span>
          </label>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <button type="submit" className="primary" disabled={busy}>
            Save handle
          </button>
          <button type="button" className="link" onClick={() => setEditing(false)}>
            Cancel
          </button>
        </form>
      ) : (
        <button type="button" onClick={() => setEditing(true)}>
          Change handle
        </button>
      )}
    </div>
  );
}

/** Your name: how connections and new spaces see you (each space can show its own). */
function NameCard({
  api,
  account,
  onChanged,
}: {
  api: Api;
  account: AccountInfo;
  onChanged(): void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(account.name);
  const [error, setError] = useState<string>();
  const save = async () => {
    setError(undefined);
    try {
      await api.updateAccount({ name: name.trim() });
      setEditing(false);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="card stack">
      <div>
        <div className="muted small">Your name</div>
        <div className="device-name">{account.name}</div>
        <div className="muted small">
          What your connections see. Each household or team shows its own name for you on its
          phones' keys; its guardians or admins can change that on their People page.
        </div>
      </div>
      {editing ? (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <label>
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={24} required />
          </label>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <button type="submit" className="primary" disabled={!name.trim()}>
            Save name
          </button>
          <button type="button" className="link" onClick={() => setEditing(false)}>
            Cancel
          </button>
        </form>
      ) : (
        <button type="button" onClick={() => setEditing(true)}>
          Change name
        </button>
      )}
    </div>
  );
}

/** Take your data with you, or delete your account (docs/privacy.md). */
function LeaveCard({ api, handle, onDeleted }: { api: Api; handle: string; onDeleted(): void }) {
  const [confirm, setConfirm] = useState("");
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string>();
  const [handOn, setHandOn] = useState<{ id: string; name: string }[]>();
  const download = async () => {
    setError(undefined);
    try {
      const blob = await api.exportAccount();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${handle}@${location.host}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const remove = async () => {
    setError(undefined);
    setHandOn(undefined);
    try {
      await api.deleteAccount(confirm);
      onDeleted();
    } catch (e) {
      const spaces = (e as { body?: { spaces?: { id: string; name: string }[] } }).body?.spaces;
      if (errorCode(e) === "owner_must_transfer" && spaces) setHandOn(spaces);
      else setError((e as Error).message);
    }
  };
  return (
    <details
      className="card stack leave"
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary>Your data</summary>
      <p className="small muted">
        Download everything this server keeps about your account (connections, spaces, phones, call
        log) as a file. Voicemail audio stays in the Voicemail tab.
      </p>
      <button type="button" onClick={() => void download()}>
        Download my data
      </button>
      <p className="small muted">
        Deleting your account: households and teams where you're the only person are deleted too
        (their phones are wiped and their voicemail deleted). Ones you own with other people in them
        must be handed to someone else first. Anywhere else, only you leave; the others stay. Your
        connections are told you've left, you're signed out everywhere, and your handle stays
        reserved for 90 days.
      </p>
      <label>
        Type your handle ({handle}) to confirm
        <input value={confirm} onChange={(e) => setConfirm(e.target.value)} autoCapitalize="none" />
      </label>
      <button
        type="button"
        className="danger"
        disabled={confirm.trim().toLowerCase() !== handle}
        onClick={() => void remove()}
      >
        Delete my account
      </button>
      {handOn && (
        <div className="warning" role="alert">
          <p>You own these, and other people are in them. Hand each to someone else first:</p>
          <ul className="bullets">
            {handOn.map((s) => (
              <li key={s.id}>{s.name}</li>
            ))}
          </ul>
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </details>
  );
}
