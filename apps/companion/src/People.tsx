import { type FormEvent, useCallback, useEffect, useState } from "react";
import type { Api, Role, User } from "./api.ts";
import { inviteLink } from "./session.ts";

interface Props {
  api: Api;
  me: User | undefined;
  onBack(): void;
}

interface Shared {
  forName: string;
  link: string;
  kind: "invite" | "sign-in";
}

/** Guardians: who's in the household, invite links, sign-in links, and removal. */
export function People({ api, me, onBack }: Props) {
  const [users, setUsers] = useState<User[]>([]);
  const [error, setError] = useState<string>();
  const [name, setName] = useState("");
  const [role, setRole] = useState<Role>("contact");
  const [busy, setBusy] = useState(false);
  const [shared, setShared] = useState<Shared>();
  const [confirmRemove, setConfirmRemove] = useState<string>();

  const load = useCallback(async () => {
    try {
      setUsers(await api.users());
    } catch (e) {
      setError((e as Error).message);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const invite = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const { token } = await api.invite({ name: name.trim(), role });
      setShared({ forName: name.trim(), link: inviteLink(location.origin, token), kind: "invite" });
      setName("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const signInLink = async (u: User) => {
    setError(undefined);
    try {
      const { token } = await api.invite({ userId: u.id });
      setShared({ forName: u.name, link: inviteLink(location.origin, token), kind: "sign-in" });
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const remove = async (u: User) => {
    setError(undefined);
    setConfirmRemove(undefined);
    try {
      await api.removeUser(u.id);
    } catch (err) {
      setError((err as Error).message);
    }
    await load();
  };

  return (
    <section className="stack">
      <button type="button" className="link back" onClick={onBack}>
        ← Back
      </button>
      <h2>People</h2>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {shared && <ShareLink shared={shared} onDone={() => setShared(undefined)} />}

      <ul className="stack">
        {users.map((u) => (
          <li key={u.id} className="card person">
            <div>
              <div className="device-name">
                {u.name}
                {u.id === me?.id && <span className="muted small"> (you)</span>}
              </div>
              <div className="muted small">{u.role === "guardian" ? "Guardian" : "Contact"}</div>
            </div>
            <div className="device-actions">
              <button type="button" onClick={() => void signInLink(u)}>
                Sign-in link
              </button>
              {u.id !== me?.id &&
                (confirmRemove === u.id ? (
                  <>
                    <button type="button" className="danger" onClick={() => void remove(u)}>
                      Remove {u.name}?
                    </button>
                    <button
                      type="button"
                      className="link"
                      onClick={() => setConfirmRemove(undefined)}
                    >
                      Keep
                    </button>
                  </>
                ) : (
                  <button type="button" className="danger" onClick={() => setConfirmRemove(u.id)}>
                    Remove
                  </button>
                ))}
            </div>
          </li>
        ))}
      </ul>

      <form className="card stack" onSubmit={(e) => void invite(e)}>
        <h3>Invite someone</h3>
        <p className="muted small">
          They'll get a link to join. Then add them to a phone's allow-list so they can call.
        </p>
        <label>
          Name (as it appears on the phone)
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Grandma"
            maxLength={24}
            required
          />
        </label>
        <fieldset className="choice">
          <legend>They are a…</legend>
          <label className="check">
            <input
              type="radio"
              name="role"
              checked={role === "contact"}
              onChange={() => setRole("contact")}
            />
            Contact — can call phones they're allowed on
          </label>
          <label className="check">
            <input
              type="radio"
              name="role"
              checked={role === "guardian"}
              onChange={() => setRole("guardian")}
            />
            Guardian — can also manage phones, people and quiet hours
          </label>
        </fieldset>
        <button type="submit" className="primary" disabled={busy || !name.trim()}>
          {busy ? "Creating link…" : "Create invite link"}
        </button>
      </form>
    </section>
  );
}

function ShareLink({ shared, onDone }: { shared: Shared; onDone(): void }) {
  const [copied, setCopied] = useState(false);
  const canShare = typeof navigator.share === "function";
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(shared.link);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  const share = async () => {
    try {
      await navigator.share({
        title: "OpenTinCan",
        text:
          shared.kind === "invite"
            ? `Join our OpenTinCan phone, ${shared.forName}:`
            : `Your OpenTinCan sign-in link, ${shared.forName}:`,
        url: shared.link,
      });
    } catch {
      // Share sheet dismissed.
    }
  };
  return (
    <div className="card stack share" role="status">
      <h3>
        {shared.kind === "invite"
          ? `Invite for ${shared.forName}`
          : `Sign-in link for ${shared.forName}`}
      </h3>
      <input
        className="link-field"
        readOnly
        value={shared.link}
        onFocus={(e) => e.currentTarget.select()}
        aria-label="Link"
      />
      <p className="muted small">
        Works once and expires in 7 days. Send it only to {shared.forName}.
      </p>
      <div className="row">
        <button type="button" className="primary" onClick={() => void copy()}>
          {copied ? "Copied" : "Copy link"}
        </button>
        {canShare && (
          <button type="button" onClick={() => void share()}>
            Share…
          </button>
        )}
        <button type="button" className="link" onClick={onDone}>
          Done
        </button>
      </div>
    </div>
  );
}
