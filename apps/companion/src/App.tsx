import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { type Api, createApi, type DeviceSummary, type Household, type User } from "./api.ts";
import { CallOverlay } from "./CallOverlay.tsx";
import { Connection, type Snapshot } from "./connection.ts";
import { Home } from "./Home.tsx";
import { ManageDevice } from "./ManageDevice.tsx";
import { Pair } from "./Pair.tsx";
import { QuietHours } from "./QuietHours.tsx";
import { Setup, SignedOut } from "./Setup.tsx";
import { loadToken, readSetupToken, saveToken } from "./session.ts";

export type Route =
  | { name: "home" }
  | { name: "pair" }
  | { name: "device"; id: string }
  | { name: "quiet" };

function clearHash() {
  history.replaceState(null, "", location.pathname + location.search);
}

export function App() {
  const [token, setToken] = useState(() => loadToken(localStorage));
  const [setupToken] = useState(() => readSetupToken(location.hash));

  const signIn = useCallback((t: string | null) => {
    saveToken(localStorage, t);
    setToken(t);
  }, []);

  useEffect(() => {
    if (token && setupToken) clearHash();
  }, [token, setupToken]);

  if (!token && setupToken) {
    return (
      <Setup
        setupToken={setupToken}
        onDone={(t) => {
          clearHash();
          signIn(t);
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
            <button type="button" className="link" onClick={() => setRoute({ name: "quiet" })}>
              Quiet hours
            </button>
          )}
          <button type="button" className="link" onClick={() => void signOut()}>
            Sign out
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
      </main>

      {conn && <CallOverlay snap={snap} conn={conn} />}
    </div>
  );
}
