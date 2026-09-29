import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Account } from "./Account.tsx";
import { Admin } from "./Admin.tsx";
import {
  type Api,
  createApi,
  type DeviceSummary,
  type Me,
  type Role,
  type Schedule,
  type User,
} from "./api.ts";
import { CallOverlay } from "./CallOverlay.tsx";
import { Connections } from "./Connections.tsx";
import { Connection, type Snapshot } from "./connection.ts";
import { groupConnections } from "./connectionGroups.ts";
import { Home } from "./Home.tsx";
import { AddHousehold, GetStarted, HouseholdSwitcher } from "./Households.tsx";
import { Invite } from "./Invite.tsx";
import { GuestLounge, LoungePhones, LoungeScan } from "./Lounge.tsx";
import { type LoungeLink, parseLoungeLink } from "./loungeLink.ts";
import { ManageDevice } from "./ManageDevice.tsx";
import { Pair } from "./Pair.tsx";
import { PasskeyOffer } from "./PasskeyOffer.tsx";
import { People } from "./People.tsx";
import { phoneLed } from "./phoneLed.ts";
import { QuietHours } from "./QuietHours.tsx";
import { quietStatus } from "./quietStatus.ts";
import { Setup } from "./Setup.tsx";
import { Start } from "./Start.tsx";
import { loadToken, readInviteToken, readSetupToken, saveToken } from "./session.ts";
import { kidSafe } from "./spaces.ts";
import { VoicemailInbox } from "./Voicemail.tsx";
import { Welcome } from "./Welcome.tsx";
import { WhatsWhat } from "./WhatsWhat.tsx";
import { finishWelcome, markWelcomePending, welcomePending } from "./welcomeState.ts";

export type Route =
  | { name: "home" }
  | { name: "pair"; mine?: boolean }
  | { name: "help" }
  | { name: "device"; id: string }
  | { name: "quiet" }
  | { name: "people"; role?: Role }
  | { name: "add-household" }
  | { name: "account" }
  | { name: "connections" }
  | { name: "admin" }
  | { name: "voicemail" };

function clearHash() {
  history.replaceState(null, "", location.pathname + location.search);
}

export function App() {
  const [token, setToken] = useState(() => loadToken(localStorage));
  // Cleared once used, so signing out later shows the signed-out screen, not setup again.
  const [setupToken, setSetupToken] = useState(() => readSetupToken(location.hash));
  const [inviteToken, setInviteToken] = useState(() => readInviteToken(location.hash));
  /** Bumped to reload everything, e.g. after switching household. */
  const [generation, setGeneration] = useState(0);
  const reload = useCallback(() => setGeneration((g) => g + 1), []);
  /** A fresh session from first-run setup, waiting on the passkey offer. */
  const [offerFor, setOfferFor] = useState<string>();
  /** Opened from a Lounge phone's QR code (survives signing in first). */
  const [loungeLink, setLoungeLink] = useState(() =>
    parseLoungeLink(location.pathname, location.hash),
  );
  const doneLounge = useCallback(() => {
    history.replaceState(null, "", "/");
    setLoungeLink(undefined);
  }, []);

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
        sessionToken={token}
        onDone={(t, joinedAsMe) => {
          clearHash();
          setInviteToken(undefined);
          if (joinedAsMe) reload();
          else {
            markWelcomePending(localStorage);
            signIn(t);
          }
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
          markWelcomePending(localStorage);
          setOfferFor(t);
        }}
      />
    );
  }
  if (!token) {
    return (
      <>
        {loungeLink && !loungeLink.host && <GuestLounge link={loungeLink} />}
        <Start
          onToken={(t, fresh) => {
            if (fresh) markWelcomePending(localStorage);
            signIn(t);
          }}
          onInvite={setInviteToken}
        />
      </>
    );
  }
  return (
    <SignedIn
      key={generation}
      onReload={reload}
      token={token}
      onSignOut={() => signIn(null)}
      loungeLink={loungeLink}
      onLoungeDone={doneLounge}
    />
  );
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

function SignedIn({
  token,
  onSignOut,
  onReload,
  loungeLink,
  onLoungeDone,
}: {
  token: string;
  onSignOut: () => void;
  /** Remounts with fresh data (after switching or joining a household). */
  onReload: () => void;
  loungeLink?: LoungeLink | undefined;
  onLoungeDone(): void;
}) {
  // `/me` says which household is active; every other request is pinned to it, so this tab
  // keeps acting in one household even if another tab switches.
  const baseApi: Api = useMemo(
    () => createApi({ token, onUnauthorized: onSignOut }),
    [token, onSignOut],
  );
  const [meInfo, setMeInfo] = useState<Me>();
  const householdId = meInfo?.household?.id;
  const api: Api = useMemo(
    () =>
      createApi({
        token,
        onUnauthorized: onSignOut,
        ...(householdId ? { household: householdId } : {}),
      }),
    [token, onSignOut, householdId],
  );
  const me =
    meInfo?.user && meInfo.household
      ? { user: meInfo.user, household: meInfo.household }
      : undefined;
  const memberships = meInfo?.memberships ?? [];
  const { conn, snap } = useConnection(token, householdId, onSignOut);
  const [people, setPeople] = useState<User[]>([]);
  // Your own "taking calls" flag; the server persists it and /api/me reports it.
  const [available, setAvailable] = useState(true);
  const [devices, setDevices] = useState<DeviceSummary[]>([]);
  const [route, setRoute] = useState<Route>({ name: "home" });
  const [loadError, setLoadError] = useState<string>();
  const [unheard, setUnheard] = useState(0);
  /** Knocks waiting for this person's answer (Connections tab badge). */
  const [knocks, setKnocks] = useState(0);
  const [toast, setToast] = useState<string>();

  const switchTo = useCallback(
    async (id: string) => {
      try {
        await baseApi.switchHousehold(id);
        onReload();
      } catch (e) {
        setLoadError((e as Error).message);
      }
    },
    [baseApi, onReload],
  );

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

  const loadMe = useCallback(() => {
    baseApi.me().then(
      (m) => {
        setMeInfo(m);
        setAvailable(m.available ?? true);
      },
      (e: Error) => setLoadError(e.message),
    );
  }, [baseApi]);
  useEffect(() => loadMe(), [loadMe]);

  useEffect(() => {
    if (!householdId) return;
    void refresh();
    void loadPeople();
  }, [householdId, refresh, loadPeople]);

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
  const spaceType = me?.household.type;
  const home = kidSafe(spaceType);

  // Phone presence reaches guardians live via `device.status`; everyone also re-reads the phone
  // list periodically (own phones' online state), and quickly while a new virtual phone pairs.
  const [pairingSince, setPairingSince] = useState<number>();
  const [welcome, setWelcome] = useState(() => welcomePending(localStorage));
  const hasOwnPhone = devices.some((d) => me && d.ownerUserId === me.user.id);
  useEffect(() => {
    if (!householdId) return;
    const fast = pairingSince !== undefined && !hasOwnPhone && Date.now() - pairingSince < 90_000;
    const t = setInterval(() => void refresh(), fast ? 2_000 : 15_000);
    return () => clearInterval(t);
  }, [refresh, pairingSince, hasOwnPhone, householdId]);

  // Household quiet hours, for the header dot (re-evaluated every minute).
  const [schedule, setSchedule] = useState<Schedule>();
  const [minute, setMinute] = useState(() => Date.now());
  useEffect(() => {
    if (!householdId) return;
    api.quietHours().then(setSchedule, () => {});
    const t = setInterval(() => setMinute(Date.now()), 60_000);
    return () => clearInterval(t);
  }, [api, householdId]);
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
    if (!guardian || !householdId) return;
    try {
      setUnheard((await api.voicemails()).filter((v) => !v.heardAt).length);
    } catch {
      // The inbox shows its own errors.
    }
  }, [api, guardian, householdId]);

  useEffect(() => {
    void countUnheard();
  }, [countUnheard]);

  const connSeq = snap.connectionsSeq ?? 0;
  useEffect(() => {
    void connSeq;
    baseApi.connections().then(
      (c) => setKnocks(groupConnections(c.connections).requests.length),
      () => {},
    );
  }, [baseApi, connSeq]);

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
        <HouseholdSwitcher
          memberships={memberships}
          activeId={householdId}
          onSwitch={(id) => void switchTo(id)}
          onAdd={() => setRoute({ name: "add-household" })}
        />
        <button
          type="button"
          className={`phone-led led-${led.color}${led.pulse ? " pulse" : ""}${snap.status === "open" ? "" : " socket-down"}`}
          title={snap.status === "open" ? led.label : `${led.label} · reconnecting to the server`}
          aria-label={
            snap.status === "open" ? led.label : `${led.label}. Reconnecting to the server.`
          }
          onClick={openLed}
        />
        <button
          type="button"
          className="help-button"
          aria-label="What's what — help"
          title="What's what"
          onClick={() => setRoute({ name: "help" })}
        >
          ?
        </button>
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
          {guardian && home && (
            <Tab route={route} name="quiet" onGo={setRoute}>
              <span className="wide-only">Quiet hours</span>
              <span className="narrow-only">Quiet</span>
            </Tab>
          )}
          <Tab route={route} name="connections" onGo={setRoute}>
            <span className="wide-only">Connections</span>
            <span className="narrow-only">Connect</span>
            {knocks > 0 && <span className="count">{knocks}</span>}
          </Tab>
          <Tab route={route} name="account" onGo={setRoute}>
            Account
          </Tab>
          {meInfo?.operator && (
            <Tab route={route} name="admin" onGo={setRoute}>
              Operator
            </Tab>
          )}
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
        {meInfo && !me && route.name !== "add-household" && route.name !== "account" && (
          <section className="card stack">
            <h2>You're not in a household yet</h2>
            <p className="muted">Ask a guardian for an invite link, or start your own household.</p>
            <button type="button" onClick={() => setRoute({ name: "add-household" })}>
              Add a household
            </button>
            <button type="button" onClick={() => void signOut()}>
              Sign out
            </button>
          </section>
        )}
        {route.name === "add-household" && (
          <AddHousehold
            api={baseApi}
            onCreated={() => onReload()}
            onCancel={() => setRoute({ name: "home" })}
          />
        )}
        {me && loungeLink && (
          <LoungeScan
            link={loungeLink}
            snap={snap}
            conn={conn}
            api={api}
            devices={devices}
            onDone={onLoungeDone}
          />
        )}
        {!loungeLink && welcome && me && (
          <Welcome
            householdName={me.household.name}
            meId={me.user.id}
            userName={me.user.name}
            onAddingPhone={() => setPairingSince(Date.now())}
            onPairHardware={() => setRoute({ name: "pair", mine: true })}
            onDone={() => {
              finishWelcome(localStorage);
              setWelcome(false);
            }}
          />
        )}
        {!(welcome && me) && route.name === "help" && (
          <WhatsWhat onBack={() => setRoute({ name: "home" })} />
        )}
        {me && !loungeLink && !welcome && route.name === "home" && guardian && (
          <GetStarted
            spaceType={spaceType}
            onAddKidPhone={() => setRoute({ name: "pair" })}
            onInviteGuardian={() => setRoute({ name: "people", role: "guardian" })}
            onAddHousehold={() => setRoute({ name: "add-household" })}
          />
        )}
        {me && !loungeLink && !welcome && route.name === "home" && (
          <LoungePhones
            api={api}
            devices={devices}
            live={snap.live}
            members={snap.members}
            people={others}
            meId={me?.user.id}
            guardian={guardian}
            conn={conn}
            onCallPerson={(u) => void conn?.callUser(u.id, u.name)}
          />
        )}
        {me && !loungeLink && !welcome && route.name === "home" && (
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
        {me && route.name === "pair" && (
          <Pair
            api={api}
            guardian={guardian}
            kidsAllowed={home}
            defaultMine={route.mine ?? false}
            onDone={() => {
              void refresh();
              setRoute({ name: "home" });
            }}
            onCancel={() => setRoute({ name: "home" })}
          />
        )}
        {me && route.name === "device" && (
          <ManageDevice
            api={api}
            device={devices.find((d) => d.id === route.id)}
            deviceId={route.id}
            meId={me?.user.id}
            guardian={guardian}
            onBack={() => {
              void refresh();
              setRoute({ name: "home" });
            }}
            onChanged={() => void refresh()}
            onRemoved={() => {
              void refresh();
              setRoute({ name: "home" });
            }}
          />
        )}
        {me && route.name === "quiet" && (
          <QuietHours
            api={api}
            onBack={() => setRoute({ name: "home" })}
            onPhones={() => setRoute({ name: "home" })}
          />
        )}
        {me && route.name === "people" && (
          <People
            key={route.role ?? "any"}
            {...(route.role ? { initialRole: route.role } : {})}
            api={api}
            me={me?.user}
            members={snap.members}
            onCall={(u) => void conn?.callUser(u.id, u.name)}
            onBack={() => setRoute({ name: "home" })}
            householdName={me?.household.name ?? "your household"}
          />
        )}
        {meInfo && route.name === "account" && (
          <Account
            account={meInfo.account}
            memberships={memberships}
            onSwitch={(id) => void switchTo(id)}
            onAddHousehold={() => setRoute({ name: "add-household" })}
            onAccountChanged={loadMe}
            api={api}
            me={me?.user}
            available={available}
            onAvailable={changeAvailable}
            onBack={() => setRoute({ name: "home" })}
            onSignOut={() => void signOut()}
            onHelp={() => setRoute({ name: "help" })}
          />
        )}
        {meInfo && route.name === "connections" && (
          <Connections
            api={baseApi}
            refreshKey={connSeq}
            onRequests={setKnocks}
            onBack={() => setRoute({ name: "home" })}
            onCall={(c) => void conn?.callConnection(c.id, c.name)}
            onCallPhone={(c, p) => void conn?.callSharedPhone(c.id, p.deviceId, p.label)}
          />
        )}
        {meInfo?.operator && route.name === "admin" && (
          <Admin api={baseApi} onBack={() => setRoute({ name: "home" })} />
        )}
        {me && route.name === "voicemail" && (
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
