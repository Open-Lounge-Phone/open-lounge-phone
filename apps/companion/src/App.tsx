import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Account } from "./Account.tsx";
import { type Api, createApi, type DeviceSummary, type Household, type User } from "./api.ts";
import { CallOverlay } from "./CallOverlay.tsx";
import { Connection, type Snapshot } from "./connection.ts";
import { Home } from "./Home.tsx";
import { Invite } from "./Invite.tsx";
import { ManageDevice } from "./ManageDevice.tsx";
import { Pair } from "./Pair.tsx";
import { PasskeyOffer } from "./PasskeyOffer.tsx";
import { People } from "./People.tsx";
import { QuietHours } from "./QuietHours.tsx";
import { Setup, SignedOut } from "./Setup.tsx";
import { loadToken, readInviteToken, readSetupToken, saveToken } from "./session.ts";
import { VoicemailInbox } from "./Voicemail.tsx";

export type Route =
  | { name: "home" }
  | { name: "pair" }
  | { name: "device"; id: string }
  | { name: "quiet" }
  | { name: "people" }
  | { name: "account" }
  | { name: "voicemail" };

function clearHash() {
  history.replaceState(null, "", location.pathname + location.search);
}

export function App() {
  const [token, setToken] = useState(() => loadToken(localStorage));
  // Cleared once used, so signing out later shows the signed-out screen, not setup again.
  const [setupToken, setSetupToken] = useState(() => readSetupToken(location.hash));
  const [inviteToken, setInviteToken] = useState(() => readInviteToken(location.hash));
  /** A fresh session from first-run setup, waiting on the passkey offer. */
  const [offerFor, setOfferFor] = useState<string>();

  const signIn = useCallback((t: string | null) => {
    saveToken(localStorage, t);
    setToken(t);
  }, []);

  useEffect(() => {
    if (token && setupToken) {
      clearHash();
      setSetupToken(undefined);
    }
  }, [token, setupToken]);

  const finishOffer = useCallback(() => {
    if (offerFor) signIn(offerFor);
    setOfferFor(undefined);
  }, [offerFor, signIn]);

  if (offerFor) return <PasskeyOffer token={offerFor} onDone={finishOffer} />;

  // An invite link works even when signed in (e.g. a sign-in link for another person).
  if (inviteToken) {
    return (
      <Invite
        inviteToken={inviteToken}
        onDone={(t) => {
          clearHash();
          setInviteToken(undefined);
          signIn(t);
        }}
        onCancel={() => {
          clearHash();
          setInviteToken(undefined);
        }}
      />
    );
  }
  if (!token && setupToken) {
    return (
      <Setup
        setupToken={setupToken}
        onDone={(t) => {
          clearHash();
          setSetupToken(undefined);
          setOfferFor(t);
        }}
      />
    );
  }
  if (!token) return <SignedOut onToken={signIn} />;
  return <SignedIn token={token} onSignOut={() => signIn(null)} />;
}

const EMPTY: Snapshot = { status: "connecting", call: { phase: "idle" }, live: {}, muted: false };
const noop = () => () => {};

function useConnection(token: string, householdId: string | undefined, onUnauthorized: () => void) {
  const [conn, setConn] = useState<Connection>();
  useEffect(() => {
    // The household id routes the socket to its hub (a Durable Object on Cloudflare).
    if (!householdId) return;
    const c = new Connection(token, householdId, onUnauthorized);
    setConn(c);
    return () => c.close();
  }, [token, householdId, onUnauthorized]);
  const snap = useSyncExternalStore(conn?.subscribe ?? noop, conn?.getSnapshot ?? (() => EMPTY));
  return { conn, snap };
}

function SignedIn({ token, onSignOut }: { token: string; onSignOut: () => void }) {
  const api: Api = useMemo(
    () => createApi({ token, onUnauthorized: onSignOut }),
    [token, onSignOut],
  );
  const [me, setMe] = useState<{ user: User; household: Household }>();
  const { conn, snap } = useConnection(token, me?.household.id, onSignOut);
  const [devices, setDevices] = useState<DeviceSummary[]>([]);
  const [route, setRoute] = useState<Route>({ name: "home" });
  const [loadError, setLoadError] = useState<string>();
  const [unheard, setUnheard] = useState(0);
  const [toast, setToast] = useState<string>();

  const refresh = useCallback(async () => {
    try {
      setDevices(await api.devices());
      setLoadError(undefined);
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, [api]);

  useEffect(() => {
    api.me().then(setMe, (e: Error) => setLoadError(e.message));
    void refresh();
  }, [api, refresh]);

  // A device we haven't listed yet just came online (e.g. paired elsewhere).
  useEffect(() => {
    if (Object.keys(snap.live).some((id) => !devices.some((d) => d.id === id))) void refresh();
  }, [snap.live, devices, refresh]);

  const signOut = async () => {
    try {
      await api.logout();
    } finally {
      onSignOut();
    }
  };

  const guardian = me?.user.role === "guardian";

  const countUnheard = useCallback(async () => {
    if (!guardian) return;
    try {
      setUnheard((await api.voicemails()).filter((v) => !v.heardAt).length);
    } catch {
      // The inbox shows its own errors.
    }
  }, [api, guardian]);

  useEffect(() => {
    void countUnheard();
  }, [countUnheard]);

  // Live voicemail announcements.
  const vmSeq = snap.voicemail?.seq ?? 0;
  const vmFrom = snap.voicemail?.from;
  useEffect(() => {
    if (!vmSeq) return;
    setToast(`New voicemail from ${vmFrom}`);
    void countUnheard();
    const t = setTimeout(() => setToast(undefined), 5000);
    return () => clearTimeout(t);
  }, [vmSeq, vmFrom, countUnheard]);

  return (
    <div className="app">
      <header className="topbar">
        <button type="button" className="brand" onClick={() => setRoute({ name: "home" })}>
          <img src="/icon.svg" alt="" width={28} height={28} />
          <span>{me?.household.name ?? "OpenTinCan"}</span>
        </button>
        <span className={`conn conn-${snap.status}`} title={`Server: ${snap.status}`} />
        <nav>
          {guardian && (
            <>
              <button
                type="button"
                className="link"
                onClick={() => setRoute({ name: "voicemail" })}
                aria-label={unheard ? `Voicemail, ${unheard} new` : "Voicemail"}
              >
                Voicemail{unheard > 0 && <span className="count">{unheard}</span>}
              </button>
              <button type="button" className="link" onClick={() => setRoute({ name: "people" })}>
                People
              </button>
              <button type="button" className="link" onClick={() => setRoute({ name: "quiet" })}>
                Quiet hours
              </button>
            </>
          )}
          <button type="button" className="link" onClick={() => setRoute({ name: "account" })}>
            Account
          </button>
        </nav>
      </header>

      {(loadError || snap.error) && (
        <div className="banner" role="alert">
          <span>{snap.error ?? loadError}</span>
          <button
            type="button"
            className="link"
            onClick={() => {
              conn?.clearError();
              setLoadError(undefined);
            }}
          >
            Dismiss
          </button>
        </div>
      )}

      <main>
        {route.name === "home" && (
          <Home
            devices={devices}
            live={snap.live}
            guardian={guardian}
            userName={me?.user.name}
            onCall={(d) => void conn?.dial(d.id, d.name)}
            onManage={(d) => setRoute({ name: "device", id: d.id })}
            onPair={() => setRoute({ name: "pair" })}
          />
        )}
        {route.name === "pair" && (
          <Pair
            api={api}
            onDone={() => {
              void refresh();
              setRoute({ name: "home" });
            }}
            onCancel={() => setRoute({ name: "home" })}
          />
        )}
        {route.name === "device" && (
          <ManageDevice
            api={api}
            device={devices.find((d) => d.id === route.id)}
            deviceId={route.id}
            onBack={() => {
              void refresh();
              setRoute({ name: "home" });
            }}
          />
        )}
        {route.name === "quiet" && (
          <QuietHours api={api} onBack={() => setRoute({ name: "home" })} />
        )}
        {route.name === "people" && (
          <People api={api} me={me?.user} onBack={() => setRoute({ name: "home" })} />
        )}
        {route.name === "account" && (
          <Account
            api={api}
            me={me?.user}
            onBack={() => setRoute({ name: "home" })}
            onSignOut={() => void signOut()}
          />
        )}
        {route.name === "voicemail" && (
          <VoicemailInbox
            api={api}
            devices={devices}
            refreshKey={vmSeq}
            onChanged={() => void countUnheard()}
            onBack={() => setRoute({ name: "home" })}
          />
        )}
      </main>

      {toast && (
        <div className="toast" role="status">
          <span>{toast}</span>
          {guardian && (
            <button
              type="button"
              className="link"
              onClick={() => {
                setToast(undefined);
                setRoute({ name: "voicemail" });
              }}
            >
              Listen
            </button>
          )}
        </div>
      )}

      {conn && <CallOverlay snap={snap} conn={conn} api={api} />}
    </div>
  );
}
