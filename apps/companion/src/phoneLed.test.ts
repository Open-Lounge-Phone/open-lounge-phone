import { describe, expect, it } from "vitest";
import { type PhoneLedInput, phoneLed, pickPhone, virtualPhoneUrl } from "./phoneLed.ts";

const mine = { id: "d1", name: "Jesse's phone", online: true, ownerUserId: "me" };
const kid = { id: "d2", name: "Maya's phone", online: true, ownerUserId: null };
const base: PhoneLedInput = {
  devices: [kid, mine],
  live: {},
  meId: "me",
  guardian: true,
  quietNow: false,
  ringing: false,
};

describe("pickPhone", () => {
  it("prefers your own phone, then a household phone for guardians", () => {
    expect(pickPhone([kid, mine], "me", true)).toEqual({ device: mine, mine: true });
    expect(pickPhone([kid], "me", true)).toEqual({ device: kid, mine: false });
    expect(pickPhone([kid], "me", false)).toBeUndefined();
    expect(pickPhone([{ ...mine, ownerUserId: "other" }], "me", true)).toBeUndefined();
  });
});

describe("phoneLed", () => {
  it("is grey without a phone", () => {
    expect(phoneLed({ ...base, devices: [] })).toMatchObject({
      color: "grey",
      label: "No phone yet",
    });
  });
  it("is green when your phone is online", () => {
    expect(phoneLed(base)).toMatchObject({
      color: "green",
      label: "Your phone: online",
      deviceId: "d1",
    });
  });
  it("uses live status over the listed one", () => {
    expect(phoneLed({ ...base, live: { d1: { online: false } } })).toMatchObject({
      color: "red",
      label: "Your phone: offline",
    });
  });
  it("pulses blue while ringing, but offline wins", () => {
    expect(phoneLed({ ...base, ringing: true })).toMatchObject({ color: "blue", pulse: true });
    expect(phoneLed({ ...base, ringing: true, live: { d1: { online: false } } }).color).toBe("red");
  });
  it("shows quiet hours only for household phones", () => {
    expect(phoneLed({ ...base, quietNow: true }).color).toBe("green");
    expect(phoneLed({ ...base, devices: [kid], quietNow: true })).toMatchObject({
      color: "purple",
      label: "Maya's phone: quiet hours",
    });
  });
});

describe("virtualPhoneUrl", () => {
  it("opens the per-user profile, pairing on first use", () => {
    expect(virtualPhoneUrl("u1", "Jesse", false)).toBe("/device/?profile=me-u1");
    const u = new URL(virtualPhoneUrl("u1", "Jesse", true), "http://x");
    expect(Object.fromEntries(u.searchParams)).toEqual({
      profile: "me-u1",
      autopair: "1",
      forMe: "1",
      name: "Jesse's phone",
    });
  });
});
