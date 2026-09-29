import type {
  EndReason,
  GreetingKind,
  VoicemailOffer,
  VoicemailPrompt,
} from "@openloungephone/protocol";

/**
 * Voicemail rules shared by the server, the companion and the phones. Pure.
 *
 * A call that isn't answered goes to voicemail: no answer (after the callee's ring time),
 * declined, busy, quiet hours, unavailable or offline. A call that was never allowed (`denied`)
 * or that the caller ended does not.
 */

/** Longest message a caller can leave. */
export const VOICEMAIL_MAX_MS = 120_000;
/** Longest greeting per kind: a recorded name, or a whole custom greeting. */
export const GREETING_MAX_MS: Record<Exclude<GreetingKind, "default">, number> = {
  name: 3_000,
  custom: 30_000,
};
/** Ring time before voicemail, per person or phone. */
export const DEFAULT_RING_SECONDS = 25;
export const MIN_RING_SECONDS = 10;
export const MAX_RING_SECONDS = 60;

const TO_VOICEMAIL: ReadonlySet<EndReason> = new Set<EndReason>([
  "timeout",
  "declined",
  "busy",
  "voicemail",
  "unavailable",
  "unreachable",
]);

/** Whether a call that ended this way lets the caller leave a message. */
export function goesToVoicemail(reason: EndReason): boolean {
  return TO_VOICEMAIL.has(reason);
}

/** What to play before recording, for the default and name greetings. */
export const DEFAULT_PROMPTS: VoicemailPrompt[] = [
  "name",
  "vm.cant_take",
  "vm.leave_message",
  "vm.tone",
];

/** The words of each fixed prompt (hardware plays recordings of exactly these). */
export const PROMPT_TEXT: Record<Exclude<VoicemailPrompt, "name" | "greeting">, string> = {
  "vm.person": "The person you called",
  "vm.cant_take": "can't take your call.",
  "vm.leave_message": "Leave a message after the tone.",
  "vm.tone": "",
  "vm.sent": "Message sent.",
  "vm.not_sent": "Your message wasn't sent.",
  "greet.say_name": "Say your name after the tone, then press back.",
  "greet.say_greeting": "Record your greeting after the tone, then press back.",
  "greet.saved": "Greeting saved.",
  "greet.not_saved": "The greeting wasn't saved.",
  "greet.default": "Callers will hear the standard greeting.",
  "greet.not_allowed": "Ask a grown-up to change the greeting.",
};

/** One step of playing a greeting. `audio` = the recording (a name or a whole greeting). */
export type GreetingStep = { kind: "audio" } | { kind: "say"; text: string } | { kind: "tone" };

/**
 * The greeting as steps to play, in order. `name` is spoken unless the greeting is a recorded
 * name; a custom greeting replaces the sentence. Consecutive spoken parts are joined so speech
 * synthesis reads them as one sentence.
 */
export function greetingScript(
  kind: GreetingKind,
  name: string,
  prompts: readonly VoicemailPrompt[] = DEFAULT_PROMPTS,
): GreetingStep[] {
  const sequence: readonly VoicemailPrompt[] =
    kind === "custom" ? ["greeting", "vm.tone"] : prompts;
  const steps: GreetingStep[] = [];
  const say = (text: string) => {
    const last = steps[steps.length - 1];
    if (last?.kind === "say") last.text = `${last.text} ${text}`;
    else steps.push({ kind: "say", text });
  };
  for (const p of sequence) {
    if (p === "name") {
      if (kind === "name") steps.push({ kind: "audio" });
      else say(name.trim() || PROMPT_TEXT["vm.person"]);
    } else if (p === "greeting") {
      if (kind === "custom") steps.push({ kind: "audio" });
    } else if (p === "vm.tone") steps.push({ kind: "tone" });
    else say(PROMPT_TEXT[p]);
  }
  return steps;
}

/** The offer's greeting as text (for a status display or a transcript of what callers hear). */
export function greetingText(kind: GreetingKind, name: string): string {
  if (kind === "custom") return "(their own greeting)";
  const who = kind === "name" ? "(their name)" : name;
  return `${who} ${PROMPT_TEXT["vm.cant_take"]} ${PROMPT_TEXT["vm.leave_message"]}`;
}

export type { VoicemailOffer };
