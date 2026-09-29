import { useEffect, useState } from "react";
import { createApi, type InvitePreview } from "./api.ts";
import { PasskeyOffer } from "./PasskeyOffer.tsx";

type Stage =
  | { name: "loading" }
  | { name: "preview"; invite: InvitePreview }
  | { name: "joining"; invite: InvitePreview }
  | { name: "passkey"; token: string }
  | { name: "invalid"; message: string };

/** Opened from a `#invite=<token>` link: preview, join, then offer a passkey. */
export function Invite({
  inviteToken,
  sessionToken,
  onDone,
  onCancel,
}: {
  inviteToken: string;
  /** Signed in already: joining adds this household to your account instead of a new person. */
  sessionToken?: string | null;
  onDone(sessionToken: string, joinedAsMe: boolean): void;
  onCancel(): void;
}) {
  const [stage, setStage] = useState<Stage>({ name: "loading" });
  const [error, setError] = useState<string>();

  useEffect(() => {
    createApi({ token: null })
      .invitePreview(inviteToken)
      .then(
        (invite) => setStage({ name: "preview", invite }),
        (e: Error) => setStage({ name: "invalid", message: e.message }),
      );
  }, [inviteToken]);

  if (stage.name === "passkey") {
    return <PasskeyOffer token={stage.token} onDone={() => onDone(stage.token, false)} />;
  }

  const join = async (invite: InvitePreview) => {
    setStage({ name: "joining", invite });
    setError(undefined);
    try {
      // A sign-in link is for the person it names; any other invite joins as you if signed in.
      const asMe = !!sessionToken && !invite.existing;
      const res = await createApi({ token: asMe ? sessionToken : null }).acceptInvite(inviteToken);
      if (asMe) onDone(res.token, true);
      else setStage({ name: "passkey", token: res.token });
    } catch (e) {
      setError((e as Error).message);
      setStage({ name: "preview", invite });
    }
  };

  return (
    <div className="centered">
      <div className="card stack">
        <img src="/icon.svg" alt="" width={56} height={56} />
        {stage.name === "loading" && <p className="muted">Checking your invite…</p>}
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
        {(stage.name === "preview" || stage.name === "joining") && (
          <>
            <h1>
              {stage.invite.existing
                ? `Sign in as ${stage.invite.name}`
                : `Join ${stage.invite.householdName}`}
            </h1>
            <p>
              {stage.invite.existing
                ? `This link signs you in to ${stage.invite.householdName} on this device.`
                : sessionToken
                  ? `You're invited as ${stage.invite.name}${
                      stage.invite.role === "guardian" ? ", a guardian" : ""
                    }. Joining adds ${stage.invite.householdName} to your account; switch between your households at the top of the app.`
                  : `You're invited as ${stage.invite.name}${
                      stage.invite.role === "guardian"
                        ? ", a guardian who can also manage phones, people and quiet hours."
                        : "."
                    } Joining adds you to ${stage.invite.householdName} in this app, where you can call and be called. Next, you can set up your own phone — a virtual phone in a browser for now.`}
            </p>
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <button
              type="button"
              className="primary"
              disabled={stage.name === "joining"}
              onClick={() => void join(stage.invite)}
            >
              {stage.name === "joining" ? "Joining…" : stage.invite.existing ? "Sign in" : "Join"}
            </button>
            <button type="button" className="link" onClick={onCancel}>
              Not now
            </button>
          </>
        )}
      </div>
    </div>
  );
}
