import type { z } from "zod";

/**
 * Plain-language text for a request body that didn't validate, for the people who see it in the
 * apps ("Name can be at most 24 characters."), instead of zod's own wording ("name: Too big:
 * expected string to have <=24 characters").
 */

/** What a field is called in a message; anything else is the key in words ("ringSeconds" → "Ring seconds"). */
const FIELD_NAMES: Record<string, string> = {
  name: "Name",
  label: "Label",
  handle: "Handle",
  householdName: "Name",
  guardianName: "Your name",
  timeZone: "Time zone",
  passkeyName: "Passkey name",
  code: "Code",
  to: "Address",
  address: "Address",
  host: "Server",
  note: "Note",
  text: "Notice",
  reason: "Reason",
  extension: "Extension",
  number: "Extension",
  ringSeconds: "Ring time",
  idleMinutes: "Minutes",
  dayEnd: "End of the day",
  start: "Start time",
  end: "End time",
  days: "Days",
  members: "Members",
  userIds: "People",
  deviceIds: "Phones",
  displayName: "Name callers see",
  description: "Description",
  allow: "Allowed servers and addresses",
  queueMax: "Callers waiting",
  queueWaitSeconds: "Longest wait",
  callerPerHour: "Calls per caller",
  serverPerHour: "Calls per server",
  message: "Message",
  minutes: "Minutes",
  confirm: "Confirmation",
};

/** Default zod wording; anything else is a message the schema wrote for people. */
const ZOD_DEFAULT = /^(Invalid|Too (big|small)|Expected|Unrecognized|Required)/;

const sentence = (text: string) => {
  const t = text.trim();
  if (!t) return t;
  const s = t[0]?.toUpperCase() + t.slice(1);
  return /[.!?]$/.test(s) ? s : `${s}.`;
};

function fieldName(path: readonly PropertyKey[]): string | undefined {
  for (let i = path.length - 1; i >= 0; i--) {
    const key = path[i];
    if (typeof key !== "string") continue;
    if (key === "kind" && i > 0) continue; // a choice's kind: name the choice instead
    return (
      FIELD_NAMES[key] ??
      sentence(key.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase()).replace(/\.$/, "")
    );
  }
  return undefined;
}

/** The value at `path` in what was sent (to tell "missing" from "wrong"). */
function valueAt(input: unknown, path: readonly PropertyKey[]): unknown {
  let v = input;
  for (const key of path) {
    if (v === null || typeof v !== "object") return undefined;
    v = (v as Record<PropertyKey, unknown>)[key];
  }
  return v;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** One readable sentence for a validation problem. */
export function issueText(issue: z.core.$ZodIssue, input?: unknown): string {
  const field = fieldName(issue.path);
  const it = field ?? "This";
  if (issue.code === "custom" || !ZOD_DEFAULT.test(issue.message)) {
    // The schema's own words ("use HH:MM", "nothing to change"), with the field in front.
    return sentence(field ? `${field}: ${issue.message}` : issue.message);
  }
  switch (issue.code) {
    case "too_small": {
      const min = Number(issue.minimum);
      if (issue.origin === "string") {
        return min <= 1 ? `${it} can't be empty.` : `${it} needs at least ${min} characters.`;
      }
      if (issue.origin === "array" || issue.origin === "set") {
        return `${it}: pick at least ${min}.`;
      }
      return `${it} must be at least ${min}.`;
    }
    case "too_big": {
      const max = Number(issue.maximum);
      if (issue.origin === "string") return `${it} can be at most ${plural(max, "character")}.`;
      if (issue.origin === "array" || issue.origin === "set") return `${it}: at most ${max}.`;
      return `${it} can be at most ${max}.`;
    }
    case "invalid_type": {
      const value = valueAt(input, issue.path);
      if (value === undefined || value === null) return `${it} is missing.`;
      if (issue.expected === "int") return `${it} must be a whole number.`;
      return `${it} isn't valid.`;
    }
    case "invalid_format":
      return `${it} isn't in the right form.`;
    case "invalid_value":
    case "invalid_union":
      return `${it} isn't one of the choices.`;
    case "unrecognized_keys":
      return `${issue.keys.length === 1 ? "This field" : "These fields"} can't be changed here: ${issue.keys.join(", ")}.`;
    default:
      return `${it} isn't valid.`;
  }
}

/** The text for the first problem in a failed parse. */
export function validationText(error: z.ZodError, input?: unknown): string {
  const issue = error.issues[0];
  return issue ? issueText(issue, input) : "That request isn't valid.";
}
