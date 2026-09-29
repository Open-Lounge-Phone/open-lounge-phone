// Interop scenario between two independent servers (federation): sign-up on each, a knock across
// servers, accept, and block. Runs against any two servers with open sign-up.
import { expect } from "vitest";
import { fakeRegistration } from "./passkey.ts";
import { socket } from "./scenario.ts";

export interface ServerTarget {
  /** Where this test process reaches the server (e.g. http://127.0.0.1:8787). */
  base: string;
  /** Its public origin, which other servers and passkeys use (e.g. http://a.localhost:8787). */
  origin: string;
}

export interface Person {
  server: ServerTarget;
  token: string;
  householdId: string;
  address: string;
}

const json = { "content-type": "application/json" };

export async function api(
  p: { server: ServerTarget; token?: string },
  path: string,
  init: { method?: string; body?: unknown } = {},
) {
  const res = await fetch(`${p.server.base}/api${path}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: { ...json, ...(p.token ? { authorization: `Bearer ${p.token}` } : {}) },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : undefined };
}

/** Open sign-up with a (software) passkey: account + personal household + session. */
export async function signUp(server: ServerTarget, handle: string, name: string): Promise<Person> {
  const opts = await api({ server }, "/signup/options", {
    body: { handle, name, timeZone: "UTC" },
  });
  expect(opts.status, JSON.stringify(opts.json)).toBe(200);
  const response = await fakeRegistration(opts.json.options, server.origin);
  const done = await api({ server }, "/signup", {
    body: { challengeId: opts.json.challengeId, response },
  });
  expect(done.status, JSON.stringify(done.json)).toBe(201);
  return {
    server,
    token: done.json.token,
    householdId: done.json.household.id,
    address: done.json.account.address,
  };
}

export async function appSocket(p: Person) {
  const ws = await socket(
    `${p.server.base.replace(/^http/, "ws")}/ws/app?household=${p.householdId}`,
  );
  ws.send({ t: "app.hello", proto: 1, token: p.token });
  await ws.next("app.ready");
  return ws;
}

type Conn = { id: string; address: string; state: string; direction: string; remote: boolean };
export const connections = async (p: Person) =>
  (await api(p, "/connections")).json.connections as Conn[];

/** Jesse (server A) knocks on Bob (server B); Bob sees it live and accepts. */
export async function knockAndAccept(jesse: Person, bob: Person) {
  const bobApp = await appSocket(bob);
  const sent = await api(jesse, "/connections", { body: { to: bob.address, note: "hi Bob" } });
  expect(sent.status, JSON.stringify(sent.json)).toBe(202);
  await bobApp.next("connections.changed");
  const [knock] = await connections(bob);
  expect(knock).toMatchObject({ address: jesse.address, state: "requested", remote: true });
  const accepted = await api(bob, `/connections/${knock?.id}/accept`, { method: "POST" });
  expect(accepted.status).toBe(200);
  expect(await connections(jesse)).toMatchObject([{ address: bob.address, state: "active" }]);
  bobApp.ws.close();
}

/** Bob blocks Jesse: the connection is gone on her side, and her next knock never arrives. */
export async function block(jesse: Person, bob: Person) {
  const [row] = await connections(bob);
  expect((await api(bob, `/connections/${row?.id}/block`, { method: "POST" })).status).toBe(204);
  expect(await connections(jesse)).toEqual([]);
  expect((await api(jesse, "/connections", { body: { to: bob.address } })).status).toBe(202);
  expect((await connections(bob)).map((c) => c.state)).toEqual(["blocked"]);
}
