// The operator's "This server" card in plain words: one row per setting, with what it means.
// How to change each (the self-host variable or deploy flag) is in the docs, not here.
import type { ServerSettings } from "./api.ts";

export interface SettingRow {
  label: string;
  value: string;
  meaning: string;
}

/** Where the card links for how to change these. */
export const SERVER_SETTINGS_HELP_URL = "https://openloungephone.app/how-to/server-settings/";

const FEATURE_WORDS: Record<string, string> = {
  rooms: "rooms with other servers",
  "recording-flag": "recorded calls",
  "lounge-guests": "guests at Lounge phones",
  "key-rotation": "key rotation",
  "voicemail-greeting": "voicemail greetings",
  "presence-batch": "availability",
  transfer: "transfers",
  "public-lines": "public lines",
  "line-callback": "call me back",
  addons: "add-ons",
  "addon-shares": "add-on shares",
  "addon-about": "what add-ons do",
  "addon-leave": "giving add-on shares back",
};

const FAIR_USE_WORDS: [keyof NonNullable<ServerSettings["fairUse"]>, string][] = [
  ["callMinutesPerMonth", "call minutes a month"],
  ["roomMinutesPerMonth", "room minutes a month"],
  ["voicemailsPerMonth", "voicemails a month"],
  ["voicemailMbPerMonth", "MB of voicemail a month"],
  ["knocksPerMonth", "knocks a month"],
  ["phonesPerSpace", "phones per space"],
  ["spacesPerAccount", "spaces per account"],
];

const LIMIT_WORDS: Record<string, string> = {
  keyPages: "speed-dial pages per phone",
  knocksPerDay: "knocks a day per person",
  signupsPerIpPerHour: "sign-ups an hour per network",
  writesPerAccountPerMinute: "changes a minute per account",
  lineCallsPerCallerPerHour: "public line calls an hour per caller",
  lineCallsPerServerPerHour: "public line calls an hour per server",
};

const n = (v: number) => v.toLocaleString("en-US");
const onOff = (on: boolean) => (on ? "On" : "Off");

export const featureWords = (f: string): string => FEATURE_WORDS[f] ?? f;

/** "1,000 call minutes a month, 5 phones per space", or "Unlimited". */
export function fairUseText(f: ServerSettings["fairUse"]): string {
  if (!f) return "Unlimited";
  const parts = FAIR_USE_WORDS.flatMap(([k, words]) =>
    f[k] === undefined ? [] : [`${n(f[k] as number)} ${words}`],
  );
  return parts.length ? parts.join(", ") : "Unlimited";
}

export function serverRows(s: ServerSettings): SettingRow[] {
  const rows: SettingRow[] = [
    {
      label: "Version",
      value: s.version.server,
      meaning: `Phones and apps speaking protocol ${s.version.protocol.min}${
        s.version.protocol.max !== s.version.protocol.min ? `–${s.version.protocol.max}` : ""
      } can connect.`,
    },
    {
      label: "Sign-up",
      value: s.signup.open ? "Open to anyone" : "Invite only",
      meaning: s.signup.open
        ? "Anyone can make an account here, with their own household."
        : "People join only through an invite from someone here.",
    },
    {
      label: "Bot check on sign-up",
      value: onOff(s.signup.turnstile),
      meaning: s.signup.turnstile
        ? "A Turnstile check on the sign-up form keeps bots out."
        : "No bot check on the sign-up form.",
    },
    {
      label: "Add-ons",
      value: onOff(s.addons),
      meaning: s.addons
        ? "People may link add-ons (like an AI agent) to their accounts."
        : "Nobody can link an add-on; ones linked before can't connect or be called.",
    },
    {
      label: "Fair use",
      value: fairUseText(s.fairUse),
      meaning: s.fairUse
        ? "What each account may use. Over it, new calls and messages wait for next month; you can exempt someone."
        : "No allowance: use is counted but never refused.",
    },
    {
      label: "Call relay (TURN)",
      value: s.calls.turn ? "Set up" : "Not set up",
      meaning: s.calls.turn
        ? "Calls connect even when two people can't reach each other directly."
        : "Calls go direct only; some networks can't connect without a relay.",
    },
    {
      label: "Rooms' audio",
      value:
        s.calls.rooms === "sfu"
          ? "Through Cloudflare's media relay"
          : s.calls.rooms === "livekit"
            ? "Through your LiveKit server"
            : "Direct between people",
      meaning:
        s.calls.rooms === "mesh"
          ? "Rooms hold up to 4 people at a time."
          : "Rooms hold many people; each sends their voice once.",
    },
    {
      label: "Transcripts",
      value: onOff(s.transcription),
      meaning: s.transcription
        ? "Voicemail and recordings are turned into text (each space can turn it off)."
        : "No speech-to-text: voicemail has no transcript.",
    },
    {
      label: "Call recording",
      value: "Each space decides",
      meaning: "Off unless a space turns it on; always announced, never with a kids' phone.",
    },
    {
      label: "Calls other servers record",
      value: s.recording.refuseOtherServersRecordedCalls ? "Refused" : "Allowed",
      meaning: s.recording.refuseOtherServersRecordedCalls
        ? "A recorded call from another server never reaches people here."
        : "People here can take recorded calls from other servers (they're told).",
    },
    {
      label: "Public address",
      value: s.publicUrl ?? "Not set",
      meaning: s.publicUrl
        ? "Addresses here end in this server's name; passkeys belong to it."
        : "Taken from each visit; set it before people make passkeys or connect across servers.",
    },
    {
      label: "Federation",
      value: onOff(s.federation.on),
      meaning: s.federation.on
        ? "People here can connect with people on other servers."
        : "People connect only with others on this server.",
    },
  ];
  if (s.federation.on) {
    rows.push({
      label: "Offered to other servers",
      value: s.federation.features.map(featureWords).join(", ") || "Nothing optional",
      meaning: "What other servers may use with this one.",
    });
  }
  rows.push(
    {
      label: "Funding shown",
      value: s.funding ? `$${n(s.funding.balanceUsd)} balance` : "Not shown",
      meaning: s.funding
        ? "The app and site show how many people the balance serves."
        : "No funding card in the app.",
    },
    {
      label: "Sponsor button",
      value: s.sponsorUrl ?? "Not shown",
      meaning: s.sponsorUrl ? "Shown in the app, linking here." : "No Sponsor button.",
    },
    {
      label: "Operators",
      value:
        s.operators
          .map((o) => (o.handle ? `${o.name || o.handle} (@${o.handle})` : "an unknown account"))
          .join(", ") || "Nobody",
      meaning: "Who sees this view. An unknown account is an id that matches nobody here.",
    },
    {
      label: "Behind a proxy",
      value: s.trustProxy ? "Yes" : "No",
      meaning: s.trustProxy
        ? "Visitors' addresses come from your proxy (for rate limits)."
        : "Visitors' addresses are taken as they connect.",
    },
  );
  const limits = Object.entries(s.limits);
  if (limits.length) {
    rows.push({
      label: "Changed limits",
      value: limits.map(([k, v]) => `${n(v)} ${LIMIT_WORDS[k] ?? k}`).join(", "),
      meaning: "Limits set differently from the defaults.",
    });
  }
  return rows;
}
