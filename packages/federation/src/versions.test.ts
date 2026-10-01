import { describe, expect, it } from "vitest";
import {
  FEATURE_NAMES,
  LEGACY_FEATURES,
  negotiate,
  noCommonVersion,
  peerOffer,
} from "./versions.ts";
import { WellKnown } from "./wellKnown.ts";

const KEY = "A".repeat(43);
const doc = (extra: object = {}) =>
  WellKnown.parse({ version: 1, server_key: KEY, federation: "/fed/v1", ...extra });

describe("reading a peer's offer", () => {
  it("an 0.1 document (no versions, no features) means version 1 and the 0.1 features", () => {
    const o = peerOffer(doc({ software: "openloungephone/0.1" }));
    expect(o).toEqual({
      versions: { 1: "/fed/v1" },
      features: new Set(LEGACY_FEATURES),
      legacy: true,
      software: "openloungephone/0.1",
    });
    expect([...o.features].sort()).toEqual([...FEATURE_NAMES].sort());
  });

  it("takes versions and features as advertised, unknown ones included", () => {
    const o = peerOffer(
      doc({ version: 3, versions: { "1": "/fed/v1", "3": "/fed/v3" }, features: ["rooms", "x"] }),
    );
    expect(o.versions).toEqual({ 1: "/fed/v1", 3: "/fed/v3" });
    expect(o.features).toEqual(new Set(["rooms", "x"]));
    expect(o.legacy).toBe(false);
    expect(peerOffer(doc({ features: [] })).features.size).toBe(0);
  });

  it("never uses a base path that isn't a plain path", () => {
    for (const bad of ["/../api", "https://evil.example/x", "/fed/v1?x=1", "fed/v1", "/a/./b"]) {
      expect(peerOffer(doc({ versions: { "1": bad } })).versions).toEqual({});
    }
    expect(peerOffer(doc({ federation: "/../x" })).versions).toEqual({});
  });

  it("is tolerant: fields it can't read are dropped, never fatal for the key", () => {
    const parsed = WellKnown.safeParse({
      version: 2,
      server_key: KEY,
      federation: "/fed/v1",
      software: "x".repeat(200),
      versions: { one: "/fed/v1" },
      features: ["rooms", 7, "y".repeat(40), ...Array.from({ length: 80 }, (_, i) => `f${i}`)],
      rotation: { previous_key: "short" },
      brand_new_field: { anything: true },
    });
    expect(parsed.success).toBe(true);
    const d = parsed.data as WellKnown;
    expect(d.software).toBeUndefined();
    expect(d.versions).toBeUndefined();
    expect(d.rotation).toBeUndefined();
    expect(d.features?.[0]).toBe("rooms");
    expect(d.features).toHaveLength(64);
    expect("brand_new_field" in d).toBe(false);
    // The core fields are still required.
    expect(WellKnown.safeParse({ version: 1, federation: "/fed/v1" }).success).toBe(false);
  });
});

describe("negotiation", () => {
  it("picks the highest version both speak", () => {
    expect(negotiate({ versions: { 1: "/fed/v1", 2: "/fed/v2" } }, [1, 2, 3])).toEqual({
      ok: true,
      version: 2,
      base: "/fed/v2",
    });
    expect(negotiate({ versions: { 1: "/fed/v1", 4: "/fed/v4" } }, [1])).toEqual({
      ok: true,
      version: 1,
      base: "/fed/v1",
    });
  });

  it("reports no common version in plain words, newer or older", () => {
    const newer = negotiate({ versions: { 2: "/fed/v2" } }, [1]);
    expect(newer).toEqual({ ok: false, ours: [1], theirs: [2] });
    expect(noCommonVersion("b.example", newer as { ours: number[]; theirs: number[] })).toBe(
      "b.example only speaks a newer federation version (2); this server needs an update to talk to it",
    );
    expect(noCommonVersion("b.example", { ours: [3, 4], theirs: [1, 2] })).toBe(
      "b.example only speaks older federation versions (1, 2), which this server no longer supports; that server needs an update",
    );
    expect(noCommonVersion("b.example", { ours: [1], theirs: [] })).toBe(
      "b.example doesn't offer a federation version this server can use",
    );
  });
});
