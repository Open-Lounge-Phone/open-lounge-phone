import { describe, expect, it } from "vitest";
import { z } from "zod";
import { body } from "./httpUtil.ts";
import { validationText } from "./validation.ts";

const text = (schema: z.ZodType, input: unknown) => {
  const r = schema.safeParse(input);
  if (r.success) throw new Error("expected a failure");
  return validationText(r.error, input);
};

describe("validationText", () => {
  const Person = z.object({
    name: z.string().trim().min(1).max(24),
    handle: z.string().min(2),
    ringSeconds: z.number().int().min(5).max(120),
    role: z.enum(["guardian", "contact"]),
    members: z.array(z.string()).min(1).max(3),
  });
  const ok = { name: "Ann", handle: "ann", ringSeconds: 20, role: "contact", members: ["a"] };

  it("says what's missing instead of zod's wording", () => {
    expect(text(Person, { ...ok, name: undefined })).toBe("Name is missing.");
    expect(text(Person, { ...ok, name: 3 })).toBe("Name isn't valid.");
  });

  it("says how long text may be", () => {
    expect(text(Person, { ...ok, name: "   " })).toBe("Name can't be empty.");
    expect(text(Person, { ...ok, name: "x".repeat(25) })).toBe(
      "Name can be at most 24 characters.",
    );
    expect(text(Person, { ...ok, handle: "a" })).toBe("Handle needs at least 2 characters.");
  });

  it("says the range of numbers and lists", () => {
    expect(text(Person, { ...ok, ringSeconds: 2 })).toBe("Ring time must be at least 5.");
    expect(text(Person, { ...ok, ringSeconds: 500 })).toBe("Ring time can be at most 120.");
    expect(text(Person, { ...ok, ringSeconds: 7.5 })).toBe("Ring time must be a whole number.");
    expect(text(Person, { ...ok, members: [] })).toBe("Members: pick at least 1.");
    expect(text(Person, { ...ok, members: ["a", "b", "c", "d"] })).toBe("Members: at most 3.");
  });

  it("names unknown fields in words and choices plainly", () => {
    expect(text(Person, { ...ok, role: "boss" })).toBe("Role isn't one of the choices.");
    expect(text(z.object({ queueWaitSeconds: z.number() }), {})).toBe("Longest wait is missing.");
    expect(text(z.object({ someNewField: z.string() }), {})).toBe("Some new field is missing.");
  });

  it("keeps the schema's own words, with the field in front", () => {
    const Times = z.object({
      rules: z.array(z.object({ start: z.string().regex(/^\d\d:\d\d$/, "use a time like 09:30") })),
    });
    expect(text(Times, { rules: [{ start: "9" }] })).toBe("Start time: use a time like 09:30.");
    const Patch = z
      .object({ a: z.boolean().optional() })
      .refine((b) => b.a !== undefined, { message: "nothing to change" });
    expect(text(Patch, {})).toBe("Nothing to change.");
  });

  it("never shows zod's wording", () => {
    const all = [
      text(Person, {}),
      text(z.object({ t: z.string().regex(/x/) }), { t: "y" }),
      text(z.object({ a: z.number() }).strict(), { a: 1, b: 2 }),
      text(z.object({ k: z.discriminatedUnion("kind", [z.object({ kind: z.literal("x") })]) }), {
        k: { kind: "y" },
      }),
    ];
    for (const t of all) expect(t).not.toMatch(/Invalid|expected|received|Too (big|small)|>=|<=/);
  });
});

describe("body", () => {
  const req = (json: string) => new Request("http://x/", { method: "POST", body: json });
  const Schema = z.object({ name: z.string().trim().min(1).max(24) });

  it("returns the parsed body", async () => {
    expect(await body(req(JSON.stringify({ name: " Ann " })), Schema)).toEqual({ name: "Ann" });
  });

  it("answers 400 with a readable error", async () => {
    const res = (await body(req("{}"), Schema)) as Response;
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Name is missing." });
    const bad = (await body(req("{nope"), Schema)) as Response;
    expect(await bad.json()).toEqual({ error: "That request couldn't be read." });
  });
});
