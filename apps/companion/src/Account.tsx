import { useCallback, useEffect, useState } from "react";
import type { AccountInfo, Api, Membership, PasskeySummary, User } from "./api.ts";
import { AvailabilityToggle } from "./GrownUps.tsx";
import { YourHouseholds } from "./Households.tsx";
import { Credit, FairUseCard, FundingCard } from "./HubCards.tsx";
import { handleHint, normalizeHandle } from "./handles.ts";
import {
  defaultPasskeyName,
  passkeyErrorText,
  passkeysSupported,
  registerPasskey,
} from "./passkeys.ts";
import { SpacePrivacy } from "./SpacePrivacy.tsx";
import { formatWhen } from "./text.ts";

interface Props {
  api: Api;
  me: User | undefined;
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
}

export function Account({
  api,
  me,
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
}: Props) {
  const [passkeys, setPasskeys] = useState<PasskeySummary[]>([]);
  const [name, setName] = useState(() => defaultPasskeyName(navigator.userAgent));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
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
    } catch (e) {
      setError(passkeyErrorText(e));
    } finally {
      setBusy(false);
      await load();
    }
  };

  const remove = async (id: string) => {
    setError(undefined);
    try {
      await api.removePasskey(id);
    } catch (e) {
      setError((e as Error).message);
    }
    await load();
  };

  const now = Date.now();

  return (
    <section className="stack">
      <button type="button" className="link back" onClick={onBack}>
        ← Back
      </button>
      <h2>{me ? me.name : "Account"}</h2>
      <AvailabilityToggle available={available} onChange={onAvailable} />
      {me && (
        <p className="muted">{me.role === "guardian" ? "Guardian" : "Contact"} in this household</p>
      )}

      {account && <AddressCard api={api} account={account} onChanged={onAccountChanged} />}

      <YourHouseholds
        memberships={memberships}
        activeId={me?.householdId}
        onSwitch={onSwitch}
        onAdd={onAddHousehold}
      />

      {me && <SpacePrivacy api={api} guardian={me.role === "guardian"} />}

      <h3>Your passkeys</h3>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {notice && <p className="ok">{notice}</p>}
      {passkeys.length === 0 && (
        <p className="muted">
          No passkeys yet. Without one, you'll need a new sign-in link if you're signed out.
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
            <button type="button" className="danger" onClick={() => void remove(p.id)}>
              Remove
            </button>
          </li>
        ))}
      </ul>
      {supported ? (
        <div className="card stack">
          <label>
            Name for this device's passkey
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} />
          </label>
          <button type="button" className="primary" disabled={busy} onClick={() => void add()}>
            {busy ? "Waiting for your device…" : "Add a passkey on this device"}
          </button>
        </div>
      ) : (
        <p className="muted">
          This browser can't create passkeys here. Passkeys need HTTPS (or localhost).
        </p>
      )}

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
      {account && <LeaveCard api={api} handle={account.handle} onDeleted={onSignOut} />}
      <Credit />
    </section>
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
          onSubmit={(e) => {
            e.preventDefault();
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
              spellCheck={false}
            />
            <span className="hint">
              {hint ?? `${handle}@${host} · you can change it once a day`}
            </span>
          </label>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <button type="submit" className="primary" disabled={busy || !!hint}>
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

/** Take your data with you, or delete your account (docs/privacy.md). */
function LeaveCard({ api, handle, onDeleted }: { api: Api; handle: string; onDeleted(): void }) {
  const [confirm, setConfirm] = useState("");
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string>();
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
    try {
      await api.deleteAccount(confirm);
      onDeleted();
    } catch (e) {
      setError((e as Error).message);
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
        Deleting your account removes it and every space where you're the only guardian (their
        phones and voicemail too). Your connections are told you've left. Your handle stays reserved
        for 90 days.
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
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </details>
  );
}
