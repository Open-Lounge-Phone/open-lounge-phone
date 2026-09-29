import { expect, it } from "vitest";
import type { ConnectionView } from "./api.ts";
import { daysLeft, groupConnections, hostBadge } from "./connectionGroups.ts";

const c = (over: Partial<ConnectionView>): ConnectionView => ({
  id: "x",
  address: "a@h",
  host: "h",
  remote: false,
  name: "A",
  state: "active",
  direction: "none",
  note: null,
  createdAt: 0,
  expiresAt: null,
  ...over,
});

it("groups requests, connections, waiting knocks and blocks", () => {
  const g = groupConnections([
    c({ id: "1", name: "Zed" }),
    c({ id: "2", name: "Amy" }),
    c({ id: "3", state: "requested", direction: "in" }),
    c({ id: "4", state: "requested", direction: "out" }),
    c({ id: "5", state: "blocked" }),
  ]);
  expect(g.connected.map((x) => x.id)).toEqual(["2", "1"]);
  expect(g.requests.map((x) => x.id)).toEqual(["3"]);
  expect(g.waiting.map((x) => x.id)).toEqual(["4"]);
  expect(g.blocked.map((x) => x.id)).toEqual(["5"]);
});

it("badges remote people with their server and counts days left", () => {
  expect(hostBadge({ remote: true, host: "hub.example" })).toBe("@hub.example");
  expect(hostBadge({ remote: false, host: "l1" })).toBe("");
  expect(daysLeft(null, 0)).toBeUndefined();
  expect(daysLeft(86_400_000 * 2.5, 0)).toBe(3);
  expect(daysLeft(0, 5)).toBe(0);
});
