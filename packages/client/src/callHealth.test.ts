import { describe, expect, it } from "vitest";
import {
  GIVE_UP_MS,
  inboundAudio,
  type Link,
  linkStep,
  NEW_LINK,
  NEW_QUALITY,
  type Quality,
  qualityStep,
  RESTART_AFTER_MS,
  RESTART_EVERY_MS,
} from "./callHealth.ts";

describe("reconnecting", () => {
  const run = (offerer: boolean) => {
    let link: Link = NEW_LINK;
    const restarts: number[] = [];
    const at = (e: Parameters<typeof linkStep>[1], now: number) => {
      const r = linkStep(link, e, now, offerer);
      link = r.link;
      if (r.restart) restarts.push(now);
      return link.state;
    };
    return { at, restarts };
  };

  it("the offerer restarts ICE when a drop doesn't come back by itself; recovers", () => {
    const { at, restarts } = run(true);
    expect(at({ type: "pc", state: "connected" }, 0)).toBe("connected");
    expect(at({ type: "pc", state: "disconnected" }, 1000)).toBe("reconnecting");
    expect(at({ type: "tick" }, 1000 + RESTART_AFTER_MS - 1)).toBe("reconnecting");
    expect(restarts).toEqual([]);
    at({ type: "tick" }, 1000 + RESTART_AFTER_MS);
    expect(restarts).toEqual([1000 + RESTART_AFTER_MS]);
    // Not again at once; again after a while.
    at({ type: "tick" }, 1000 + RESTART_AFTER_MS + 1000);
    expect(restarts).toHaveLength(1);
    at({ type: "tick" }, 1000 + RESTART_AFTER_MS + RESTART_EVERY_MS);
    expect(restarts).toHaveLength(2);
    expect(at({ type: "pc", state: "connected" }, 9000)).toBe("connected");
  });

  it("failed: restart at once; the answerer waits for the offer", () => {
    const offerer = run(true);
    offerer.at({ type: "pc", state: "connected" }, 0);
    expect(offerer.at({ type: "pc", state: "failed" }, 500)).toBe("reconnecting");
    expect(offerer.restarts).toEqual([500]);
    const answerer = run(false);
    answerer.at({ type: "pc", state: "connected" }, 0);
    answerer.at({ type: "pc", state: "failed" }, 500);
    answerer.at({ type: "tick" }, 10_000);
    expect(answerer.restarts).toEqual([]);
  });

  it("gives up after a while: the call is lost, for good", () => {
    const { at } = run(false);
    at({ type: "pc", state: "connected" }, 0);
    at({ type: "pc", state: "disconnected" }, 100);
    expect(at({ type: "tick" }, 100 + GIVE_UP_MS - 1)).toBe("reconnecting");
    expect(at({ type: "tick" }, 100 + GIVE_UP_MS)).toBe("lost");
    expect(at({ type: "pc", state: "connected" }, 100 + GIVE_UP_MS + 1)).toBe("lost");
  });

  it("never claims connected before it is; an early failure is final", () => {
    const { at } = run(true);
    expect(at({ type: "pc", state: "connecting" }, 0)).toBe("connecting");
    expect(at({ type: "pc", state: "disconnected" }, 10)).toBe("connecting");
    expect(at({ type: "pc", state: "failed" }, 20)).toBe("lost");
  });
});

describe("poor connection", () => {
  const sample = (at: number, received: number, lost: number, jitter = 0.01) => ({
    at,
    packetsReceived: received,
    packetsLost: lost,
    jitter,
  });

  it("from packet loss over the window, with some hysteresis", () => {
    let q: Quality = NEW_QUALITY;
    q = qualityStep(q, sample(0, 0, 0));
    q = qualityStep(q, sample(2000, 100, 1));
    expect(q.poor).toBe(false);
    q = qualityStep(q, sample(4000, 180, 15)); // 15 lost of 195 since the start: 7.7 %
    expect(q.poor).toBe(true);
    // Still 3 % over the last ten seconds: stays poor until under 2 %.
    q = qualityStep(q, sample(12_000, 500, 15));
    expect(q.poor).toBe(true);
    q = qualityStep(q, sample(16_000, 900, 15));
    expect(q.poor).toBe(false);
  });

  it("from jitter; nothing judged from too few packets", () => {
    let q: Quality = NEW_QUALITY;
    q = qualityStep(q, sample(0, 0, 0));
    q = qualityStep(q, sample(2000, 10, 5)); // half lost, but only 15 packets (silence)
    expect(q.poor).toBe(false);
    q = qualityStep(q, sample(4000, 120, 5, 0.08));
    expect(q.poor).toBe(true);
    q = qualityStep(q, sample(6000, 300, 5, 0.01)); // 1.6 % lost, low jitter
    expect(q.poor).toBe(false);
  });

  it("reads the incoming audio from getStats", () => {
    const report = new Map<string, Record<string, unknown>>([
      ["a", { type: "outbound-rtp", kind: "audio", packetsSent: 5 }],
      [
        "b",
        { type: "inbound-rtp", kind: "audio", packetsReceived: 40, packetsLost: 2, jitter: 0.02 },
      ],
    ]) as unknown as RTCStatsReport;
    expect(inboundAudio(report, 7)).toEqual({
      at: 7,
      packetsReceived: 40,
      packetsLost: 2,
      jitter: 0.02,
    });
    expect(inboundAudio(new Map() as unknown as RTCStatsReport, 7)).toBeUndefined();
  });
});
