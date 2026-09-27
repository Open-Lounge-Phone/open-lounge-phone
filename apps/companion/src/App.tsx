import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Account } from "./Account.tsx";
import {
  type Api,
  createApi,
  type DeviceSummary,
  type Household,
  type Schedule,
  type User,
} from "./api.ts";
import { CallOverlay } from "./CallOverlay.tsx";
import { Connection, type Snapshot } from "./connection.ts";
import { Home } from "./Home.tsx";
import { Invite } from "./Invite.tsx";
import { ManageDevice } from "./ManageDevice.tsx";
import { Pair } from "./Pair.tsx";
import { PasskeyOffer } from "./PasskeyOffer.tsx";
import { People } from "./People.tsx";
import { phoneLed } from "./phoneLed.ts";
import { QuietHours } from "./QuietHours.tsx";
import { quietStatus } from "./quietStatus.ts";
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

const EMPTY: Snapshot = {
  status: "connecting",
  call: { phase: "idle" },
  live: {},
  members: {},
  muted: false,
};
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
  const [me, setMe] = useState<{ user: User; household: Household; available?: boolean }>();
  const { conn, snap } = useConnection(token, me?.household.id, onSignOut);
  const [people, setPeople] = useState<User[]>([]);
  // Your own "taking calls" flag; the server persists it and /api/me reports it.
  const [available, setAvailable] = useState(true);
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

  const loadPeople = useCallback(async () => {
    try {
      setPeople(await api.users());
    } catch {
      // Home still works without the grown-ups list.
    }
  }, [api]);

  useEffect(() => {
    api.me().then(
      (m) => {
        setMe(m);
        setAvailable(m.available ?? true);
      },
      (e: Error) => setLoadError(e.message),
    );
    void refresh();
    void loadPeople();
  }, [api, refresh, loadPeople]);

  // Someone we haven't listed yet joined the server.
  useEffect(() => {
    if (Object.keys(snap.members).some((id) => !people.some((p) => p.id === id))) {
      void loadPeople();
    }
  }, [snap.members, people, loadPeople]);

  const others = people.filter((p) => p.id !== me?.user.id);
  const changeAvailable = (v: boolean) => {
    setAvailable(v);
    if (!conn?.setAvailable(v)) setLoadError("Not connected to the server — try again");
  };

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

  // Phone presence reaches guardians live via `device.status`; everyone also re-reads the phone
  // list periodically (own phones' online state), and quickly while a new virtual phone pairs.
  const [pairingSince, setPairingSince] = useState<number>();
  const hasOwnPhone = devices.some((d) => me && d.ownerUserId === me.user.id);
  useEffect(() => {
    const fast = pairingSince !== undefined && !hasOwnPhone && Date.now() - pairingSince < 90_000;
    const t = setInterval(() => void refresh(), fast ? 2_000 : 15_000);
    return () => clearInterval(t);
  }, [refresh, pairingSince, hasOwnPhone]);

  // Household quiet hours, for the header dot (re-evaluated every minute).
  const [schedule, setSchedule] = useState<Schedule>();
  const [minute, setMinute] = useState(() => Date.now());
  useEffect(() => {
    api.quietHours().then(setSchedule, () => {});
    const t = setInterval(() => setMinute(Date.now()), 60_000);
    return () => clearInterval(t);
  }, [api]);
  const led = phoneLed({
    devices,
    live: snap.live,
    meId: me?.user.id,
    guardian,
    quietNow: schedule ? quietStatus(schedule, new Date(minute)).quiet : false,
    ringing: snap.call.phase === "incoming",
  });
  const openLed = () => {
    if (!led.deviceId || led.mine) {
      setRoute({ name: "home" });
      requestAnimationFrame(() => document.getElementById("my-phone")?.scrollIntoView());
    } else setRoute({ name: "device", id: led.deviceId });
  };

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
          <span>{me?.household.name ?? "Open Lounge Phone"}</span>
        </button>
        <button
          type="button"
          className={`phone-led led-${led.color}${led.pulse ? " pulse" : ""}${snap.status === "open" ? "" : " socket-down"}`}
          title={snap.status === "open" ? led.label : `${led.label} · reconnecting to the server`}
          aria-label={
            snap.status === "open" ? led.label : `${led.label}. Reconnecting to the server.`
          }
          onClick={openLed}
        />
        <nav className="tabs" aria-label="Sections">
          <Tab route={route} name="home" onGo={setRoute}>
            Home
          </Tab>
          {guardian && (
            <Tab route={route} name="voicemail" onGo={setRoute}>
              Voicemail{unheard > 0 && <span className="count">{unheard}</span>}
            </Tab>
          )}
          {guardian && (
            <Tab route={route} name="people" onGo={setRoute}>
              People
            </Tab>
          )}
          {guardian && (
            <Tab route={route} name="quiet" onGo={setRoute}>
              <span className="wide-only">Quiet hours</span>
              <span className="narrow-only">Quiet</span>
            </Tab>
          )}
          <Tab route={route} name="account" onGo={setRoute}>
            Account
          </Tab>
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
            people={others}
            members={snap.members}
            onCallPerson={(u) => void conn?.callUser(u.id, u.name)}
            available={available}
            onAvailable={changeAvailable}
            meId={me?.user.id}
            onAddingPhone={() => setPairingSince(Date.now())}
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
          <QuietHours
            api={api}
            onBack={() => setRoute({ name: "home" })}
            onPhones={() => setRoute({ name: "home" })}
          />
        )}
        {route.name === "people" && (
          <People
            api={api}
            me={me?.user}
            members={snap.members}
            onCall={(u) => void conn?.callUser(u.id, u.name)}
            onBack={() => setRoute({ name: "home" })}
          />
        )}
        {route.name === "account" && (
          <Account
            api={api}
            me={me?.user}
            available={available}
            onAvailable={changeAvailable}
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

function Tab({
  route,
  name,
  onGo,
  children,
}: {
  route: Route;
  name: Route["name"];
  onGo(r: Route): void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className="tab"
      aria-current={route.name === name ? "page" : undefined}
      onClick={() => onGo({ name } as Route)}
    >
      {children}
    </button>
  );
}
