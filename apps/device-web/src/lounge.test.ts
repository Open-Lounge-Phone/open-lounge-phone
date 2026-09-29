import type { DeviceState } from "@openloungephone/core";
import { describe, expect, it } from "vitest";
import { loungeKeysLive, loungeLines, loungeUrl, showQr, wantsFreshCode } from "./lounge.ts";

const idle: DeviceState = { kind: "idle" };
const offhook: DeviceState = { kind: "offhook" };
const nonce = { nonce: "abcdefghijklmnopqrstuv", expiresAt: 100_000 };

describe("Lounge phone display", () => {
  it("links the QR code to the companion's scan page", () => {
    expect(loungeUrl("https://l1.example", "dev_1", "n0nce")).toBe(
      "https://l1.example/lounge#dev_1.n0nce",
    );
  });

  it("shows the code while free, the key to press, then Hi <name>", () => {
    expect(loungeLines({ nonce }, idle)).toEqual(["SCAN TO USE", "THIS PHONE"]);
    expect(showQr({ nonce }, idle, false, 0)).toBe(true);
    expect(showQr({ nonce }, idle, true, 0)).toBe(false);
    expect(showQr({ nonce }, offhook, false, 0)).toBe(false);
    expect(showQr({ nonce }, idle, false, 100_000)).toBe(false); // expired

    const challenge = { index: 9, expiresAt: 2 };
    expect(loungeLines({ nonce, challenge }, idle)).toEqual(["PRESS KEY 0", "TO START"]);
    expect(showQr({ nonce, challenge }, idle, false, 0)).toBe(false);

    const session = { name: "Alexandria-Jones", openToChat: false };
    expect(loungeLines({ nonce, session }, idle)).toEqual(["HI ALEXANDRIA-JO", "MENU = OPTIONS"]);
    expect(loungeLines({ session: { ...session, openToChat: true } }, idle)?.[1]).toBe(
      "OPEN TO CHAT",
    );
    // Lifted or in a call: the normal call status takes over.
    expect(loungeLines({ session }, offhook)).toBeUndefined();
    expect(
      loungeLines({ session }, { kind: "incoming", callId: "c", from: "Mom" }),
    ).toBeUndefined();
    expect(loungeKeysLive({ session })).toBe(true);
    expect(loungeKeysLive({ nonce })).toBe(false);
  });

  it("asks for a new code only while it's on a visible screen and missing or expiring", () => {
    expect(wantsFreshCode({}, idle, false, 0, true)).toBe(true);
    expect(wantsFreshCode({ nonce }, idle, false, 0, true)).toBe(false);
    expect(wantsFreshCode({ nonce }, idle, false, 96_000, true)).toBe(true);
    // Not while hidden, lifted, in the menu or during the key proof.
    expect(wantsFreshCode({}, idle, false, 0, false)).toBe(false);
    expect(wantsFreshCode({}, offhook, false, 0, true)).toBe(false);
    expect(wantsFreshCode({}, idle, true, 0, true)).toBe(false);
    expect(wantsFreshCode({ challenge: { index: 1, expiresAt: 5 } }, idle, false, 0, true)).toBe(
      false,
    );
  });
});

describe("idle Lounge phone options", () => {
  const idle = { kind: "idle" as const };
  it("shows house-line keys and who's here only when the space turned them on", () => {
    expect(loungeLines({}, idle)).toEqual(["SCAN TO USE", "THIS PHONE"]);
    expect(loungeLines({ houseLine: true }, idle)).toEqual(["SCAN TO USE", "OR PRESS A KEY"]);
    expect(loungeKeysLive({ houseLine: true })).toBe(true);
    expect(loungeKeysLive({})).toBe(false);
    expect(loungeLines({ here: [{ name: "Dad", where: "Patio" }] }, idle)).toEqual([
      "SCAN TO USE",
      "HERE: DAD",
    ]);
  });
});
