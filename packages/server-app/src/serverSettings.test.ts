import { generateServerKey } from "@openloungephone/federation";
import { describe, expect, it } from "vitest";
import { expectStatus, TestServer } from "./testkit.ts";
import { SERVER_VERSION } from "./version.ts";

const SECRETS = {
  turnstile: "turnstile-secret-xyz",
  relay: "sfu-secret-xyz",
};

describe("GET /admin/server (the operator's This server card)", () => {
  it("is for operators only", async () => {
    const s = new TestServer({ publicUrl: "https://hub.test" });
    const boss = await s.person("boss");
    const eve = await s.person("eve");
    s.env.operators = [boss.account.id];
    expectStatus(await s.http("/admin/server", { token: eve.token }), 403);
    expectStatus(await s.http("/admin/server", { token: boss.token }), 200);
    // Not even a member of the operator's own space.
    s.env.operators = [];
    expectStatus(await s.http("/admin/server", { token: boss.token }), 403);
  });

  it("shows every setting in plain facts, never a secret", async () => {
    const s = new TestServer({
      publicUrl: "https://hub.test",
      env: {
        openSignup: true,
        turnstile: { siteKey: "site-key", secret: SECRETS.turnstile },
        addons: true,
        fairUse: { callMinutesPerMonth: 1000, phonesPerSpace: 5 },
        turn: true,
        relay: { kind: "cloudflare", appId: "app", appSecret: SECRETS.relay },
        refuseRecordedCalls: true,
        hub: {
          funding: { balanceUsd: 150, baseCostUsdPerMonth: 5, costPerActiveUserUsdPerMonth: 0.02 },
          sponsorUrl: "https://github.com/sponsors/example",
        },
        trustProxy: true,
        limits: { keyPages: 3, knocksPerDay: 10 },
      },
    });
    const boss = await s.person("boss", "Boss");
    s.env.operators = [boss.account.id, "acc_nobody"];
    const res = await s.http("/admin/server", { token: boss.token });
    expect(res.json).toMatchObject({
      version: { server: SERVER_VERSION },
      signup: { open: true, turnstile: true },
      addons: true,
      fairUse: { callMinutesPerMonth: 1000, phonesPerSpace: 5 },
      calls: { turn: true, rooms: "sfu" },
      transcription: true,
      recording: { spacesMayRecord: true, refuseOtherServersRecordedCalls: true },
      publicUrl: "https://hub.test",
      federation: { on: false, fingerprint: null, features: [] },
      funding: { balanceUsd: 150 },
      sponsorUrl: "https://github.com/sponsors/example",
      operators: [
        { handle: "boss", name: "Boss" },
        { handle: null, name: null },
      ],
      trustProxy: true,
      // Only what differs from the defaults.
      limits: { keyPages: 3 },
    });
    const text = JSON.stringify(res.json);
    for (const secret of Object.values(SECRETS)) expect(text).not.toContain(secret);
    expect(text).not.toContain("acc_nobody");
    expect(text).not.toContain("site-key");
  });

  it("says when things are off: invite-only, unlimited, mesh rooms, no TURN", async () => {
    const s = new TestServer();
    const boss = await s.person("boss");
    s.env.operators = [boss.account.id];
    delete s.env.transcriber;
    const res = await s.http("/admin/server", { token: boss.token });
    expect(res.json).toMatchObject({
      signup: { open: false, turnstile: false },
      addons: false,
      fairUse: null,
      calls: { turn: false, rooms: "mesh" },
      transcription: false,
      recording: { refuseOtherServersRecordedCalls: false },
      publicUrl: null,
      funding: null,
      sponsorUrl: null,
      trustProxy: false,
      limits: {},
    });
  });

  it("shows the federation key's fingerprint and the features advertised, not the key", async () => {
    const key = await generateServerKey();
    const s = new TestServer({ publicUrl: "https://a.test", env: { federationKey: key } });
    const boss = await s.person("boss");
    s.env.operators = [boss.account.id];
    const res = await s.http("/admin/server", { token: boss.token });
    const fed = (await s.http("/admin/federation", { token: boss.token })).json;
    expect(res.json.federation.on).toBe(true);
    expect(res.json.federation.fingerprint).toBe(fed.own.fingerprint);
    expect(res.json.federation.features).toContain("rooms");
    // Add-ons are off here: not advertised.
    expect(res.json.federation.features).not.toContain("addons");
    expect(JSON.stringify(res.json)).not.toContain(JSON.parse(key).d);
  });
});
