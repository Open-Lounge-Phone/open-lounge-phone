import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Account } from "./Account.tsx";
import { AddonContactsCard, Addons } from "./Addons.tsx";
import { Admin } from "./Admin.tsx";
import {
  type Api,
  createApi,
  type DeviceSummary,
  errorCode,
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
import { Invite, type InviteResult } from "./Invite.tsx";
import { GuestLounge, LoungePhones, LoungeScan } from "./Lounge.tsx";
import { type LoungeLink, parseLoungeLink } from "./loungeLink.ts";
import { ManageDevice } from "./ManageDevice.tsx";
import { Pair } from "./Pair.tsx";
import { PasskeyOffer } from "./PasskeyOffer.tsx";
import { People } from "./People.tsx";
import { phoneLed } from "./phoneLed.ts";
import { QuietHours } from "./QuietHours.tsx";
import { quietStatus } from "./quietStatus.ts";
import { RecoveryCodeStep } from "./RecoveryCode.tsx";
import { RoomPanel, Rooms } from "./Rooms.tsx";
import { Setup } from "./Setup.tsx";
import { SpaceSettings } from "./SpaceSettings.tsx";
import { Start, type StartedHow } from "./Start.tsx";
import {
  loadToken,
  readHashLinks,
  readInviteToken,
  readRecover,
  readSetupToken,
  saveToken,
} from "./session.ts";
import { kidSafe } from "./spaces.ts";
import { VoicemailInbox } from "./Voicemail.tsx";
import { Welcome } from "./Welcome.tsx";
import { WhatsWhat } from "./WhatsWhat.tsx";
import { Workplace } from "./Workplace.tsx";
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
  | { name: "rooms" }
  | { name: "admin" }
  | { name: "directory" }
  | { name: "voicemail" }
  | { name: "addons" }
  | { name: "settings" };

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
  /**
   * A fresh session waiting on steps before the app opens: a passkey offer ("another": signed
   * in from another device) and the new account's recovery code.
   */
  const [pending, setPendingState] = useState<{
    token: string;
    steps: ("passkey" | "another" | "code")[];
  }>();
  /** Saved at once, so closing the page mid-way doesn't lose a session that has no passkey yet. */
  const setPending = useCallback(
    (p: { token: string; steps: ("passkey" | "another" | "code")[] } | undefined) => {
      if (p) saveToken(localStorage, p.token);
      setPendingState(p);
    },
    [],
  );
  /** `#recover`: "Lost your passkey?" opens first. */
  const [recover, setRecover] = useState(() => readRecover(location.hash));
  /** An invite to come back to after "I already have an account here: sign in first". */
  const [inviteAfterSignIn, setInviteAfterSignIn] = useState<string>();
  /** Opened from a Lounge phone's QR code (survives signing in first). */
  const [loungeLink, setLoungeLink] = useState(() =>
    parseLoungeLink(location.pathname, location.hash),
  );
  // Links opened while the app is already open (a pasted invite, a scanned Lounge code) only
  // change the hash: read them again on every change, not just on first load.
  useEffect(() => {
    const onHash = () => {
      const links = readHashLinks(location.pathname, location.hash);
      if (links.setup) setSetupToken(links.setup);
      if (links.invite) setInviteToken(links.invite);
      if (links.lounge) setLoungeLink(links.lounge);
      if (links.recover) setRecover(true);
    };
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);
  const doneLounge = useCallback(() => {
    history.replaceState(null, "", "/");
    setLoungeLink(undefined);
  }, []);

  const signIn = useCallback(
    (t: string | null) => {
      saveToken(localStorage, t);
      setToken(t);
      // Back to an invite opened before signing in.
      if (t && inviteAfterSignIn) {
        setInviteToken(inviteAfterSignIn);
        setInviteAfterSignIn(undefined);
      }
    },
    [inviteAfterSignIn],
  );
  const forgetStaleToken = useCallback(() => {
    saveToken(localStorage, null);
    setToken(null);
  }, []);

  useEffect(() => {
    if (token && setupToken) {
      clearHash();
      setSetupToken(undefined);
    }
  }, [token, setupToken]);

  const nextStep = useCallback(() => {
    if (!pending) return;
    const steps = pending.steps.slice(1);
    if (steps.length > 0) setPending({ ...pending, steps });
    else {
      signIn(pending.token);
      setPending(undefined);
    }
  }, [pending, signIn, setPending]);

  if (pending) {
    const step = pending.steps[0];
    if (step === "code") return <RecoveryCodeStep token={pending.token} onDone={nextStep} />;
    return <PasskeyOffer token={pending.token} another={step === "another"} onDone={nextStep} />;
  }

  // An invite link works even when signed in (e.g. a sign-in link for another person).
  if (inviteToken) {
    return (
      <Invite
        inviteToken={inviteToken}
        sessionToken={token}
        onDone={(r: InviteResult) => {
          clearHash();
          setInviteToken(undefined);
          if (r.joinedAsMe) {
            reload();
            return;
          }
          markWelcomePending(localStorage);
          // Always keep the session the server gave back.
          saveToken(localStorage, r.token);
          if (r.newAccount) setPending({ token: r.token, steps: ["passkey", "code"] });
          else signIn(r.token);
        }}
        onCancel={() => {
          clearHash();
          setInviteToken(undefined);
        }}
        onStaleSession={forgetStaleToken}
        onSignInFirst={() => {
          clearHash();
          setInviteAfterSignIn(inviteToken);
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
          setPending({ token: t, steps: ["passkey", "code"] });
        }}
      />
    );
  }
  if (!token) {
    return (
      <>
        {loungeLink && !loungeLink.host && <GuestLounge link={loungeLink} />}
        <Start
          key={recover ? "recover" : "menu"}
          initial={recover ? "recover" : "menu"}
          onToken={(t, how?: StartedHow) => {
            if (recover) {
              clearHash();
              setRecover(false);
            }
            if (how?.fresh) {
              markWelcomePending(localStorage);
              setPending({ token: t, steps: ["code"] });
            } else if (how?.offerPasskey) setPending({ token: t, steps: ["another"] });
            else signIn(t);
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

function useConnection(
  token: string,
  householdId: string | undefined,
  onUnauthorized: () => void,
  onRemoved: () => void,
) {
  const [conn, setConn] = useState<Connection>();
  useEffect(() => {
    // The household id routes the socket to its hub (a Durable Object on Cloudflare).
    if (!householdId) return;
    const c = new Connection(token, householdId, onUnauthorized, onRemoved);
    setConn(c);
    return () => c.close();
  }, [token, householdId, onUnauthorized, onRemoved]);
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
  const [suspended, setSuspended] = useState(false);
  // The socket was closed as signed out: ask the server why (a suspension shows as such; an
  // ended session signs this app out through the API's 401).
  const onSocketSignedOut = useCallback(() => {
    baseApi.me().then(
      () => {},
      (e: Error) => {
        if (errorCode(e) === "suspended") setSuspended(true);
      },
    );
  }, [baseApi]);
  // Left or removed from this space, or a role changed there: reload with fresh data.
  const { conn, snap } = useConnection(token, householdId, onSocketSignedOut, onReload);
  const [people, setPeople] = useState<User[]>([]);
  // Your own "taking calls" flag; the server persists it and /api/me reports it.
  const [available, setAvailable] = useState(true);
  const [devices, setDevices] = useState<DeviceSummary[]>([]);
  const [route, setRoute] = useState<Route>({ name: "home" });
  const [loadError, setLoadError] = useState<string>();
  const [unheard, setUnheard] = useState(0);
  /** Knocks waiting for this person's answer (Connections tab badge). */
  const [knocks, setKnocks] = useState(0);
  /** The Add-ons tab: when this server offers add-ons, or you have some (or shares of some). */
  const [addonsTab, setAddonsTab] = useState(false);
  const [toast, setToast] = useState<string>();
  /** A party line that just opened: its toast offers to join. */
  const [opened, setOpened] = useState<{ roomId: string; name: string }>();

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
      (e: Error) => {
        if (errorCode(e) === "suspended") setSuspended(true);
        else setLoadError(e.message);
      },
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
    if (!householdId) return;
    try {
      setUnheard((await api.voicemails()).filter((v) => !v.heardAt).length);
    } catch {
      // The inbox shows its own errors.
    }
  }, [api, householdId]);

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
    Promise.all([
      baseApi.addons().catch(() => undefined),
      baseApi.addonsShared().catch(() => undefined),
      baseApi.addonsGone().catch(() => []),
    ]).then(([mine, held, gone]) =>
      // Also while a note of something that went waits to be read.
      setAddonsTab(
        !!mine?.enabled || !!mine?.addons.length || !!held?.held.length || gone.length > 0,
      ),
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

  // A party line with hours just opened: offer to join.
  const openedSeq = snap.roomOpened?.seq ?? 0;
  useEffect(() => {
    const o = snap.roomOpened;
    if (!openedSeq || !o) return;
    setOpened({ roomId: o.roomId, name: o.name });
    const t = setTimeout(() => setOpened(undefined), 60_000);
    return () => clearTimeout(t);
  }, [openedSeq, snap.roomOpened]);

  if (suspended) {
    return (
      <div className="centered">
        <div className="card stack">
          <h1>This account is suspended</h1>
          <p>
            The people who run this server have suspended this account, so it can't be used here for
            now. They can tell you why.
          </p>
          <button type="button" onClick={onSignOut}>
            Sign out
          </button>
        </div>
      </div>
    );
  }

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
          canAdd={meInfo?.canAddSpace !== false}
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
          <Tab route={route} name="voicemail" onGo={setRoute}>
            Voicemail{unheard > 0 && <span className="count">{unheard}</span>}
          </Tab>
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
          {!home && me && (
            <Tab route={route} name="directory" onGo={setRoute}>
              Directory
            </Tab>
          )}
          <Tab route={route} name="rooms" onGo={setRoute}>
            Rooms
          </Tab>
          {addonsTab && (
            <Tab route={route} name="addons" onGo={setRoute}>
              Add-ons
            </Tab>
          )}
          <Tab route={route} name="connections" onGo={setRoute}>
            <span className="wide-only">Connections</span>
            <span className="narrow-only">Connect</span>
            {knocks > 0 && <span className="count">{knocks}</span>}
          </Tab>
          {me && (
            <Tab route={route} name="settings" onGo={setRoute}>
              Settings
            </Tab>
          )}
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

      <AccountBanners
        me={meInfo}
        notice={snap.accountNotice}
        onAccount={() => setRoute({ name: "account" })}
      />
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
            <h2>You're not in a household or team yet</h2>
            <p className="muted">
              {meInfo.canAddSpace
                ? "Ask someone in a household or team here to invite you, or start your own."
                : "Ask someone in a household or team here to invite you. Your account is still here: you can take your data or delete it under Account."}
            </p>
            {meInfo.canAddSpace && (
              <button type="button" onClick={() => setRoute({ name: "add-household" })}>
                Add a household or team
              </button>
            )}
            <button type="button" onClick={() => setRoute({ name: "account" })}>
              Account
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
            canAdd={meInfo?.canAddSpace !== false}
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
            onManage={(d) => setRoute({ name: "device", id: d.id })}
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
            api={api}
            {...(snap.missedSeq ? { missedSeq: snap.missedSeq } : {})}
            onCallBack={(hint, label) => {
              if (!conn) return;
              if (hint.kind === "user") void conn.callUser(hint.userId, label);
              else if (hint.kind === "device") void conn.dial(hint.deviceId, label);
              else if (hint.kind === "connection")
                void conn.callConnection(hint.connectionId, label);
              else void conn.callLine(hint.address);
            }}
            onManage={(d) => setRoute({ name: "device", id: d.id })}
            onPair={() => setRoute({ name: "pair" })}
          />
        )}
        {me && !loungeLink && !welcome && route.name === "home" && (
          <AddonContactsCard
            api={api}
            conn={conn}
            refreshKey={connSeq}
            onAddons={() => setRoute({ name: "addons" })}
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
            spaceType={spaceType}
          />
        )}
        {meInfo && route.name === "account" && (
          <Account
            info={meInfo}
            spaceType={spaceType}
            onLeft={onReload}
            onPeople={() => setRoute({ name: "people" })}
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
            onCallLine={(address) => void conn?.callLine(address)}
            onCallAddon={(address, label) => void conn?.callAddon(address, label)}
            onAddons={() => setRoute({ name: "addons" })}
          />
        )}
        {me && route.name === "rooms" && (
          <Rooms
            api={api}
            conn={conn}
            snap={snap}
            guardian={guardian}
            onBack={() => setRoute({ name: "home" })}
          />
        )}
        {me && !home && route.name === "directory" && (
          <Workplace api={api} conn={conn} onBack={() => setRoute({ name: "home" })} />
        )}
        {me && route.name === "settings" && (
          <SpaceSettings
            api={api}
            household={me.household}
            canEdit={guardian}
            onChanged={loadMe}
            onBack={() => setRoute({ name: "home" })}
          />
        )}
        {me && route.name === "addons" && (
          <Addons
            api={api}
            conn={conn}
            address={meInfo?.account?.address}
            devices={devices}
            meId={me.user.id}
            onBack={() => setRoute({ name: "home" })}
          />
        )}
        {meInfo?.operator && route.name === "admin" && (
          <Admin api={baseApi} sessionToken={token} onBack={() => setRoute({ name: "home" })} />
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
        </div>
      )}

      {opened && !toast && (
        <div className="toast" role="status">
          <span>{opened.name} is open</span>
          <button
            type="button"
            className="link"
            onClick={() => {
              setOpened(undefined);
              void conn?.joinRoom({ roomId: opened.roomId });
            }}
          >
            Join
          </button>
        </div>
      )}

      {conn && (
        <CallOverlay snap={snap} conn={conn} people={others} api={baseApi} extensions={!home} />
      )}
      {conn && <RoomPanel snap={snap} conn={conn} />}
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

/**
 * Lasting reminders about getting back in: no recovery code yet, a session with no passkey
 * behind it (it ends on a date), and a sign-in to this account that didn't use a passkey.
 */
function AccountBanners({
  me,
  notice,
  onAccount,
}: {
  me: Me | undefined;
  notice: Snapshot["accountNotice"];
  onAccount(): void;
}) {
  const [seenNotice, setSeenNotice] = useState(0);
  if (!me) return null;
  const ends = me.session && !me.session.passkey ? new Date(me.session.expiresAt) : undefined;
  return (
    <>
      {notice && notice.seq > seenNotice && (
        <div className="banner" role="alert">
          <span>
            {notice.kind === "recovered"
              ? "Someone just signed in to your account with its recovery code."
              : "Someone just signed in to your account with a sign-in link."}{" "}
            If that wasn't you, check where you're signed in.
          </span>
          <span className="row">
            <button type="button" className="link" onClick={onAccount}>
              Check
            </button>
            <button type="button" className="link" onClick={() => setSeenNotice(notice.seq)}>
              Dismiss
            </button>
          </span>
        </div>
      )}
      {ends && (
        <div className="banner notice" role="status">
          <span>
            This device has no passkey. You'll be signed out on{" "}
            {ends.toLocaleDateString(undefined, { dateStyle: "medium" })}; add a passkey or keep
            your recovery code.
          </span>
          <button type="button" className="link" onClick={onAccount}>
            Add a passkey
          </button>
        </div>
      )}
      {me.recoveryCode === false && (
        <div className="banner notice" role="status">
          <span>
            Your account has no recovery code yet. Make one, so you can get back in if you lose your
            passkeys.
          </span>
          <button type="button" className="link" onClick={onAccount}>
            Make one
          </button>
        </div>
      )}
    </>
  );
}
