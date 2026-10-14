import { describe, expect, it } from "vitest";
import { zoneGroups, zoneLabel, zoneProblem } from "./timeZones.ts";

describe("time zones", () => {
  it("labels zones the way people say them", () => {
    expect(zoneLabel("America/New_York")).toBe("New York");
    expect(zoneLabel("America/Argentina/Buenos_Aires")).toBe("Buenos Aires, Argentina");
    expect(zoneLabel("UTC")).toBe("UTC");
  });

  it("groups by region, sorted, with this device's zone always present", () => {
    const groups = zoneGroups(
      ["Europe/London", "America/New_York", "America/Chicago", "UTC"],
      "Asia/Calcutta",
    );
    expect(groups.map((g) => g.region)).toEqual(["America", "Asia", "Europe", "Other"]);
    expect(groups[0]?.zones.map((z) => z.value)).toEqual(["America/Chicago", "America/New_York"]);
    expect(groups[1]?.zones.map((z) => z.value)).toEqual(["Asia/Calcutta"]);
  });

  it("leaves out a device zone that isn't real", () => {
    expect(zoneGroups(["UTC"], "Mars/Olympus").flatMap((g) => g.zones.map((z) => z.value))).toEqual(
      ["UTC"],
    );
  });

  it("says what's wrong with a typed zone", () => {
    expect(zoneProblem("")).toBe("Choose a time zone.");
    expect(zoneProblem("Eastern")).toMatch(/America\/New_York/);
    expect(zoneProblem("Europe/London")).toBeUndefined();
  });
});
