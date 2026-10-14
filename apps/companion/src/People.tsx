import { type FormEvent, useCallback, useEffect, useState } from "react";
import type { Api, OutstandingLink, Role, User } from "./api.ts";
import type { MemberLive } from "./connection.ts";
import { requiredProblem } from "./fields.ts";
import { presenceOf } from "./presence.ts";
import { inviteLink } from "./session.ts";
import { kidSafe, roleNoun, type SpaceType, spaceNoun } from "./spaces.ts";
import { formatWhen } from "./text.ts";

interface Props {
  api: Api;
  me: User | undefined;
  members: Record<string, MemberLive>;
  onCall(u: User): void;
  onBack(): void;
  householdName: string;
  /** Pre-selects the role in the invite form ("Invite a co-guardian"). */
  initialRole?: Role;
  /** Team/org spaces say admin/member. */
  spaceType?: SpaceType | undefined;
}

interface Shared {
  forName: string;
  link: string;
  kind: "invite" | "sign-in";
}

/** Guardians: who's in the household, invite links, sign-in links, and removal. */
export function People({
  api,
  me,
  members,
  onCall,
  onBack,
  householdName,
  initialRole = "contact",
  spaceType,
}: Props) {
  const [users, setUsers] = useState<User[]>([]);
  const [error, setError] = useState<string>();
  const [name, setName] = useState("");
  const [role, setRole] = useState<Role>(initialRole);
  const [busy, setBusy] = useState(false);
  const [nameProblem, setNameProblem] = useState<string>();
  const [shared, setShared] = useState<Shared>();
  const [confirmRemove, setConfirmRemove] = useState<string>();
  const [confirmOwner, setConfirmOwner] = useState<string>();
  const [renaming, setRenaming] = useState<{ id: string; name: string }>();
  const [links, setLinks] = useState<OutstandingLink[]>([]);
  const [notice, setNotice] = useState<string>();

  const load = useCallback(async () => {
    try {
      setUsers(await api.users());
      setLinks(await api.outstandingLinks());
    } catch (e) {
      setError((e as Error).message);
    }
  }, [api]);
  const home = kidSafe(spaceType);
  const noun = spaceNoun(spaceType);
  const iOwn = users.some((u) => u.id === me?.id && u.owner);
  /** Admins (guardians) other than the owner can't act on the owner, nor (teams) other admins. */
  const mayManage = (u: User) => !u.owner && (iOwn || home || u.role !== "guardian");

  useEffect(() => {
    void load();
  }, [load]);

  const invite = async (e: FormEvent) => {
    e.preventDefault();
    const problem = requiredProblem(name, "their name");
    setNameProblem(problem);
    if (problem) return;
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
    await load();
  };

  const remove = async (u: User) => {
    setError(undefined);
    setNotice(undefined);
    setConfirmRemove(undefined);
    try {
      const { accountDeleted } = await api.removeUser(u.id);
      setNotice(
        accountDeleted
          ? `${u.name} was removed, and their account deleted.`
          : `${u.name} was removed from this ${noun}.`,
      );
    } catch (err) {
      setError((err as Error).message);
    }
    await load();
  };

  const changeRole = async (u: User, to: Role) => {
    setError(undefined);
    try {
      await api.setRole(u.id, to);
    } catch (err) {
      setError((err as Error).message);
    }
    await load();
  };

  const handOver = async (u: User) => {
    setError(undefined);
    setConfirmOwner(undefined);
    try {
      await api.transferOwnership(u.id);
      setNotice(`${u.name} now owns this ${noun}.`);
    } catch (err) {
      setError((err as Error).message);
    }
    await load();
  };

  const rename = async () => {
    if (!renaming) return;
    setError(undefined);
    try {
      await api.renameUser(renaming.id, renaming.name.trim());
      setRenaming(undefined);
    } catch (err) {
      setError((err as Error).message);
    }
    await load();
  };

  const cancelLink = async (l: OutstandingLink) => {
    setError(undefined);
    try {
      await api.cancelLink(l.id);
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

      {notice && <p className="ok">{notice}</p>}
      {shared && <ShareLink shared={shared} onDone={() => setShared(undefined)} />}

      <ul className="stack">
        {users.map((u) => {
          const self = u.id === me?.id;
          const p = presenceOf(members[u.id]);
          return (
            <li key={u.id} className="card person device">
              <div className="device-main">
                {!self && <span className={`dot ${p.dot}`} role="img" aria-label={p.label} />}
                <div>
                  <div className="device-name">
                    {u.name}
                    {self && <span className="muted small"> (you)</span>}
                  </div>
                  <div className="muted small">
                    {u.owner ? "Owner" : roleNoun(u.role, spaceType)}
                    {!self && ` · ${p.label}`}
                  </div>
                  {renaming?.id === u.id && (
                    <form
                      className="row"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void rename();
                      }}
                    >
                      <input
                        aria-label={`New name for ${u.name}`}
                        value={renaming.name}
                        onChange={(e) => setRenaming({ id: u.id, name: e.target.value })}
                        maxLength={24}
                        required
                      />
                      <button type="submit" disabled={!renaming.name.trim()}>
                        Save
                      </button>
                      <button type="button" className="link" onClick={() => setRenaming(undefined)}>
                        Cancel
                      </button>
                    </form>
                  )}
                  {confirmOwner === u.id && (
                    <div className="stack">
                      <p className="small">
                        Make {u.name} the owner of {householdName}? You'll stay a{" "}
                        {home ? "guardian" : "admin"}, but only {u.name} can then change roles, hand
                        it on again, or remove you.
                      </p>
                      <div className="row">
                        <button type="button" className="danger" onClick={() => void handOver(u)}>
                          Yes, make {u.name} the owner
                        </button>
                        <button
                          type="button"
                          className="link"
                          onClick={() => setConfirmOwner(undefined)}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                  {confirmRemove === u.id && (
                    <p className="small warning">
                      {u.onlyHere
                        ? `This is ${u.name}'s only space here, so removing them deletes their account: their connections are told, and they'd need a new invite to come back.`
                        : `${u.name} stays in their other spaces; only this ${noun} goes.`}
                    </p>
                  )}
                  {!self && u.onlyHere === false && !u.owner && (
                    <div className="muted small">
                      In other spaces too: signs in with a passkey or recovery code, not a link.
                    </div>
                  )}
                </div>
              </div>
              <div className="device-actions">
                {!self && (
                  <button
                    type="button"
                    className="primary"
                    disabled={!p.callable}
                    onClick={() => onCall(u)}
                  >
                    Call
                  </button>
                )}
                <button
                  type="button"
                  className="link"
                  onClick={() => setRenaming({ id: u.id, name: u.name })}
                >
                  Rename
                </button>
                {!self && u.onlyHere && mayManage(u) && (
                  <button type="button" onClick={() => void signInLink(u)}>
                    Sign-in link
                  </button>
                )}
                {!self && iOwn && home && (
                  <button
                    type="button"
                    onClick={() =>
                      void changeRole(u, u.role === "guardian" ? "contact" : "guardian")
                    }
                  >
                    {u.role === "guardian" ? "Make contact" : "Make guardian"}
                  </button>
                )}
                {!self && iOwn && u.role === "guardian" && confirmOwner !== u.id && (
                  <button type="button" onClick={() => setConfirmOwner(u.id)}>
                    Make owner
                  </button>
                )}
                {!self &&
                  mayManage(u) &&
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
          );
        })}
      </ul>

      {links.length > 0 && (
        <section className="stack">
          <h3>Links not used yet</h3>
          <ul className="stack">
            {links.map((l) => (
              <li key={l.id} className="card person">
                <div>
                  <div className="device-name">
                    {l.kind === "signin" ? `Sign-in link for ${l.name}` : `Invite for ${l.name}`}
                  </div>
                  <div className="muted small">
                    Made by {l.createdBy || "someone who left"} · expires{" "}
                    {formatWhen(l.expiresAt, Date.now())}
                  </div>
                </div>
                <button type="button" className="danger" onClick={() => void cancelLink(l)}>
                  Cancel link
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <form className="card stack" noValidate onSubmit={(e) => void invite(e)}>
        <h3>Invite someone</h3>
        <p className="muted small">
          They'll get a link. Opening it adds them to {householdName} in this app, where they can
          call and be called. They can also set up their own phone (a virtual phone in a browser, or
          an Open Lounge Phone).
        </p>
        <label>
          Name (as it appears on the phone)
          <input
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setNameProblem(undefined);
            }}
            maxLength={24}
            aria-invalid={nameProblem ? true : undefined}
          />
          <span className={nameProblem ? "hint error" : "hint"}>
            {nameProblem ?? "Up to 24 characters, for example Grandma."}
          </span>
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
            {kidSafe(spaceType)
              ? "Contact — can call and be called by the phones they're allowed on"
              : "Member — in the directory, can call and be called"}
          </label>
          {(home || iOwn) && (
            <label className="check">
              <input
                type="radio"
                name="role"
                checked={role === "guardian"}
                onChange={() => setRole("guardian")}
              />
              {home
                ? "Guardian — can also manage phones, people and quiet hours"
                : "Admin — can also manage people, extensions, ring groups and hours"}
            </label>
          )}
        </fieldset>
        <button type="submit" className="primary" disabled={busy}>
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
        title: "Open Lounge Phone",
        text:
          shared.kind === "invite"
            ? `Join our Open Lounge Phone phone, ${shared.forName}:`
            : `Your Open Lounge Phone sign-in link, ${shared.forName}:`,
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
