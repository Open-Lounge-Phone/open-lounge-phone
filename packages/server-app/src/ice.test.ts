import { describe, expect, it } from "vitest";
import { buildIceServers } from "./ice.ts";

describe("ICE servers", () => {
  const cfg = { stunUrls: ["stun:s:3478"], turnUrls: ["turn:t:3478"], turnSecret: "s3cret" };
  it("TURN credentials expire after the host's default, or sooner when asked (add-on calls)", async () => {
    const now = 1_700_000_000_000;
    const expiry = (servers: Awaited<ReturnType<typeof buildIceServers>>) =>
      Number(servers[1]?.username?.split(":")[0]) - now / 1000;
    expect(expiry(await buildIceServers(cfg, now))).toBe(6 * 60 * 60);
    expect(expiry(await buildIceServers(cfg, now, 4 * 60 * 60 + 120))).toBe(4 * 60 * 60 + 120);
  });
});
