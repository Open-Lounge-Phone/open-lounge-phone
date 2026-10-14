import { useEffect, useState } from "react";
import { type AccountInfo, createApi, errorCode, type InvitePreview } from "./api.ts";

type Stage =
  | { name: "loading" }
  | { name: "preview"; invite: InvitePreview }
  | { name: "joining"; invite: InvitePreview }
  | { name: "already"; invite: InvitePreview; householdId: string }
  | { name: "invalid"; message: string };

/** How opening the link ended (see App). */
export interface InviteResult {
  /** The session to keep (always the one the server gave back). */
  token: string;
  /** Joined with the account already signed in here (the app just reloads). */
  joinedAsMe: boolean;
  /** A brand-new account: a passkey offer and its recovery code come next. */
  newAccount: boolean;
}

/**
 * Opened from a `#invite=<token>` link: an invite for a new person, or a sign-in link for
 * someone already in a space. Says plainly who you'll be signed in as.
 */
export function Invite({
  inviteToken,
  sessionToken,
  onDone,
  onCancel,
  onStaleSession,
  onSignInFirst,
}: {
  inviteToken: string;
  /** The session saved on this device, if any (it may be stale). */
  sessionToken?: string | null;
  onDone(result: InviteResult): void;
  onCancel(): void;
  /** The saved session no longer works: forget it. */
  onStaleSession(): void;
  /** "I already have an account here": sign in first, then come back to this invite. */
  onSignInFirst(): void;
}) {
  const [stage, setStage] = useState<Stage>({ name: "loading" });
  const [error, setError] = useState<string>();
  /** Who is signed in on this device now (undefined: nobody, or not known yet). */
  const [me, setMe] = useState<AccountInfo>();
  const [session, setSession] = useState(sessionToken ?? null);

  useEffect(() => {
    createApi({ token: null })
      .invitePreview(inviteToken)
      .then(
        (invite) => setStage({ name: "preview", invite }),
        (e: Error) => setStage({ name: "invalid", message: e.message }),
      );
  }, [inviteToken]);

  useEffect(() => {
    if (!sessionToken) return;
    createApi({ token: sessionToken })
      .me()
      .then(
        (m) => setMe(m.account),
        (e: { status?: number }) => {
          // A stale saved session: forget it, and carry on signed out.
          if (e.status === 401) {
            setSession(null);
            onStaleSession();
          }
        },
      );
  }, [sessionToken, onStaleSession]);

  const signedInAs = session && me ? me : undefined;

  const accept = async (invite: InvitePreview, asMe: boolean) => {
    setStage({ name: "joining", invite });
    setError(undefined);
    const tryWith = (token: string | null) => createApi({ token }).acceptInvite(inviteToken);
    try {
      let res: Awaited<ReturnType<typeof tryWith>>;
      try {
        res = await tryWith(asMe ? session : null);
      } catch (e) {
        if (!asMe || (e as { status?: number }).status !== 401) throw e;
        // The saved session expired meanwhile: forget it and join signed out.
        setSession(null);
        onStaleSession();
        res = await tryWith(null);
      }
      if (!asMe && session) {
        // Someone else was signed in on this device: they're signed out now.
        await createApi({ token: session })
          .logout()
          .catch(() => {});
      }
      onDone({
        token: res.token,
        joinedAsMe: asMe && res.token === session,
        newAccount: res.newAccount === true,
      });
    } catch (e) {
      const code = errorCode(e);
      if (code === "already_member") {
        const householdId = (e as { body?: { householdId?: string } }).body?.householdId ?? "";
        setStage({ name: "already", invite, householdId });
        return;
      }
      setError(
        code === "suspended"
          ? "Your account is suspended on this server, so it can't join. Its operator can tell you why."
          : (e as Error).message,
      );
      setStage({ name: "preview", invite });
    }
  };

  const openSpace = async (householdId: string) => {
    if (!session) return;
    try {
      await createApi({ token: session }).switchHousehold(householdId);
    } catch {
      // It still opens; the switcher at the top picks the space.
    }
    onDone({ token: session, joinedAsMe: true, newAccount: false });
  };

  const role = (invite: InvitePreview) =>
    invite.role === "guardian" ? ", a guardian who can also manage phones and people" : "";

  return (
    <div className="centered">
      <div className="card stack">
        <img src="/icon.svg" alt="" width={56} height={56} />
        {stage.name === "loading" && <p className="muted">Checking your link…</p>}
        {stage.name === "invalid" && (
          <>
            <h1>This link can't be used</h1>
            <p>{stage.message}</p>
            <p className="muted">
              Ask whoever sent it for a new one — links work once, for 7 days.
            </p>
            <button type="button" onClick={onCancel}>
              OK
            </button>
          </>
        )}
        {stage.name === "already" && (
          <>
            <h1>You're already in {stage.invite.householdName}</h1>
            <p>
              Your account ({signedInAs?.address ?? "the one signed in here"}) is already a member,
              so there's nothing to join. This invite is still unused; whoever sent it can cancel
              it.
            </p>
            <button
              type="button"
              className="primary"
              onClick={() => void openSpace(stage.householdId)}
            >
              Open {stage.invite.householdName}
            </button>
            <button type="button" className="link" onClick={onCancel}>
              Close
            </button>
          </>
        )}
        {(stage.name === "preview" || stage.name === "joining") &&
          (stage.invite.existing ? (
            <>
              <h1>Sign in as {stage.invite.name}</h1>
              {signedInAs ? (
                <p>
                  You're signed in as <strong className="address">{signedInAs.address}</strong>.
                  This link signs you in as {stage.invite.name} instead, and signs{" "}
                  {signedInAs.handle} out on this device.
                </p>
              ) : (
                <p>
                  This link signs you in as {stage.invite.name} ({stage.invite.householdName}) on
                  this device, without a passkey. It works once. Add a passkey after, so you can
                  sign in again yourself.
                </p>
              )}
              {error && (
                <p className="error" role="alert">
                  {error}
                </p>
              )}
              <button
                type="button"
                className="primary"
                disabled={stage.name === "joining"}
                onClick={() => void accept(stage.invite, false)}
              >
                {stage.name === "joining" ? "Signing in…" : `Sign in as ${stage.invite.name}`}
              </button>
              <button type="button" className="link" onClick={onCancel}>
                Not now
              </button>
            </>
          ) : (
            <>
              <h1>Join {stage.invite.householdName}</h1>
              <p>
                You're invited as {stage.invite.name}
                {role(stage.invite)}. Joining adds you to {stage.invite.householdName} in this app,
                where you can call and be called.
              </p>
              {error && (
                <p className="error" role="alert">
                  {error}
                </p>
              )}
              {signedInAs ? (
                <>
                  <button
                    type="button"
                    className="primary"
                    disabled={stage.name === "joining"}
                    onClick={() => void accept(stage.invite, true)}
                  >
                    {stage.name === "joining" ? "Joining…" : `Join as ${signedInAs.handle}`}
                  </button>
                  <p className="muted small">
                    Adds {stage.invite.householdName} to your account,{" "}
                    <span className="address">{signedInAs.address}</span>; switch between your
                    spaces at the top of the app.
                  </p>
                  <button
                    type="button"
                    disabled={stage.name === "joining"}
                    onClick={() => void accept(stage.invite, false)}
                  >
                    I'm someone else (sign {signedInAs.handle} out first)
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className="primary"
                    disabled={stage.name === "joining"}
                    onClick={() => void accept(stage.invite, false)}
                  >
                    {stage.name === "joining" ? "Joining…" : "Join as someone new"}
                  </button>
                  <button type="button" onClick={onSignInFirst}>
                    I already have an account here: sign in first
                  </button>
                </>
              )}
              <button type="button" className="link" onClick={onCancel}>
                Not now
              </button>
            </>
          ))}
      </div>
    </div>
  );
}
