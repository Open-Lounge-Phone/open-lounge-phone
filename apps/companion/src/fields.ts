/**
 * Checks for form fields, in plain words, matching what the server accepts: each returns what
 * to fix, or undefined when the value is fine. Forms show the text next to the field on submit.
 */
import { lineEntry } from "@openloungephone/core";

/** "write a notice" → "Write a notice." (core and server messages are lower case). */
export function sentence(text: string): string {
  const t = text.trim();
  if (!t) return t;
  const s = (t[0]?.toUpperCase() ?? "") + t.slice(1);
  return /[.!?]$/.test(s) ? s : `${s}.`;
}

/** A required text field: `what` is how the message names it ("a name", "the phone's name"). */
export function requiredProblem(value: string, what: string): string | undefined {
  return value.trim() ? undefined : `Enter ${what}.`;
}

const EXTENSION = /^[0-9]{2,6}$/;

/** Extensions are 2 to 6 digits (the server's rule). */
export function extensionProblem(value: string): string | undefined {
  if (!value) return "Enter an extension: 2 to 6 digits.";
  return EXTENSION.test(value) ? undefined : "Use 2 to 6 digits.";
}

/** Keeps only digits, at most 6: what an extension field holds while typing. */
export const extensionDigits = (typed: string) => typed.replace(/\D/g, "").slice(0, 6);

/** An address `name@server` (a person, a room or a public line). */
export function addressProblem(value: string): string | undefined {
  const v = value.trim();
  if (!v) return "Enter an address, like name@server.";
  const entry = lineEntry(v);
  if (entry?.kind === "address") return undefined;
  if (entry?.kind === "server") return "That's a server. Add the name in front: name@server.";
  return "That doesn't look like an address. Use name@server.";
}

/**
 * A server's name as people paste it ("https://Spam.Example/path", "@spam.example") → the name
 * the server checks ("spam.example"); also takes the server out of an address.
 */
export function serverName(value: string): string {
  let v = value.trim().toLowerCase();
  v = v.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  v = v.split(/[/?#]/)[0] ?? "";
  if (v.includes("@")) v = v.slice(v.lastIndexOf("@") + 1);
  return v.replace(/\.$/, "");
}

/** A server's name (after `serverName`). */
export function serverProblem(value: string): string | undefined {
  if (!value.trim()) return "Enter the server's name, like example.org.";
  return lineEntry(serverName(value))?.kind === "server"
    ? undefined
    : "That doesn't look like a server's name. Use something like example.org.";
}

/** A whole number from `min` to `max` typed into a number field. */
export function wholeNumber(
  value: string,
  min: number,
  max: number,
): { value: number } | { problem: string } {
  const range = `Use a whole number from ${min} to ${max}.`;
  const v = value.trim();
  if (!v) return { problem: range };
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) return { problem: range };
  return { value: n };
}

/** A time from a time field ("HH:MM"); empty when someone cleared it. */
export function timeProblem(value: string, what = "a time"): string | undefined {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value) ? undefined : `Pick ${what}.`;
}
