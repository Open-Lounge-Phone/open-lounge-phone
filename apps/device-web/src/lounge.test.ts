import type { DeviceState } from "@openloungephone/core";
import { describe, expect, it } from "vitest";
import { loungeKeysLive, loungeLines, loungeUrl, showQr } from "./lounge.ts";

const idle: DeviceState = { kind: "idle" };
const offhook: DeviceState = { kind: "offhook" };
const nonce = { nonce: "abcdefghijklmnopqrstuv", expiresAt: 1 };

describe("Lounge phone display", () => {
  it("links the QR code to the companion's scan page", () => {
    expect(loungeUrl("https://l1.example", "dev_1", "n0nce")).toBe(
      "https://l1.example/lounge#dev_1.n0nce",
    );
  });

  it("shows the code while free, the key to press, then Hi <name>", () => {
    expect(loungeLines({ nonce }, idle)).toEqual(["SCAN TO USE", "THIS PHONE"]);
    expect(showQr({ nonce }, idle, false)).toBe(true);
    expect(showQr({ nonce }, idle, true)).toBe(false);
    expect(showQr({ nonce }, offhook, false)).toBe(false);

    const challenge = { index: 9, expiresAt: 2 };
    expect(loungeLines({ nonce, challenge }, idle)).toEqual(["PRESS KEY 0", "TO START"]);
    expect(showQr({ nonce, challenge }, idle, false)).toBe(false);

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
});
