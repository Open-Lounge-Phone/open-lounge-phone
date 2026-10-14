import { describe, expect, it } from "vitest";
import { d1Rows, resolveOperators } from "./operators.ts";

const accounts = [
  { id: "acc_JesseAAAAAAAAAAA", handle: "jesse" },
  { id: "acc_BobBBBBBBBBBBBBB", handle: "bob" },
];
/** A stand-in for D1: answers the one query `resolveOperators` makes. */
const db = (sql: string) => {
  const names = [...sql.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  return accounts.filter((a) => names.includes(a.handle) || names.includes(a.id));
};

describe("deploy --operator", () => {
  it("turns handles into account ids, once, and keeps ids as given", () => {
    expect(resolveOperators("jesse", db)).toEqual([
      { handle: "jesse", id: "acc_JesseAAAAAAAAAAA" },
    ]);
    expect(resolveOperators("@Jesse@hub.example, acc_BobBBBBBBBBBBBBB", db)).toEqual([
      { handle: "jesse", id: "acc_JesseAAAAAAAAAAA" },
      { handle: "bob", id: "acc_BobBBBBBBBBBBBBB" },
    ]);
  });

  it("refuses a handle that isn't an account here, and anything that isn't a handle", () => {
    expect(() => resolveOperators("ghost", db)).toThrow(/no account .* ghost/);
    expect(() => resolveOperators("jesse,ghost", db)).toThrow(/ghost/);
    expect(() => resolveOperators("x' OR '1'='1", db)).toThrow(/not a handle/);
    expect(() => resolveOperators(" , ", db)).toThrow();
  });

  it("reads wrangler's JSON", () => {
    expect(d1Rows(JSON.stringify([{ results: [{ id: "acc_x" }], success: true }]))).toEqual([
      { id: "acc_x" },
    ]);
    expect(d1Rows("[]")).toEqual([]);
  });
});
