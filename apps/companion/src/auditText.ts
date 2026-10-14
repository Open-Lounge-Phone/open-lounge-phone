/** A space's audit trail in words ("changed quiet hours"). Pure. */

/** The digit on a phone for a key index (0-8 → 1-9, 9 → 0). */
const digit = (index: unknown) =>
  typeof index === "number" ? String(index === 9 ? 0 : index + 1) : "a";

/** One audit entry in words ("set extension 201"), after the name of who did it. */
export function auditText(action: string, d: Record<string, unknown> | null): string {
  const s = (k: string) => (d && typeof d[k] === "string" ? (d[k] as string) : "");
  const phone = s("phone") || "a phone";
  switch (action) {
    case "space.rename":
      return `renamed "${s("from")}" to "${s("to")}"`;
    case "space.timezone":
      return `changed the time zone to ${s("to").replace(/_/g, " ")} (was ${s("from").replace(/_/g, " ")})`;
    case "quiet.update":
      return "changed quiet hours";
    case "extension.set":
      return `set extension ${s("number")}`;
    case "extension.delete":
      return `removed extension ${s("number")}`;
    case "group.create":
      return `made ring group ${s("name")} (${s("extension")})`;
    case "group.update":
      return "changed a ring group";
    case "group.delete":
      return `deleted ring group ${s("name")}`;
    case "hours.update":
      return "changed business hours";
    case "room.hours":
      return "changed a party line's hours";
    case "role.change":
      return `made ${s("name")} ${s("role") === "admin" ? "an admin" : "a member"}`;
    case "invite.create":
      return `invited ${s("name")}`;
    case "member.remove":
      return `removed ${s("name")}`;
    case "privacy.update":
      return "changed privacy settings";
    case "phone.add":
      return `added phone ${s("name")}`;
    case "phone.remove":
      return `removed phone ${s("name")}`;
    case "phone.rename":
      return `renamed ${phone} to ${s("name")}`;
    case "phone.contact":
      return `changed what ${phone} may do with ${s("name") || "someone"}`;
    case "phone.contact.remove":
      return `took someone off ${phone}'s list`;
    case "phone.key":
      return `changed key ${digit(d?.index)} on ${phone}`;
    case "phone.room":
      return `put room ${s("name")} on ${phone}`;
    case "phone.line":
      return `put public line ${s("address")} on ${phone}`;
    case "phone.voicemail":
      return `changed ${phone}'s voicemail settings`;
    case "phone.greeting":
      return s("kind") === "default"
        ? `reset ${phone}'s greeting`
        : `recorded a greeting for ${phone}`;
    case "lounge.settings":
      return "changed the Lounge phone settings";
    case "notice.post":
      return "posted a notice";
    case "notice.audio":
      return "added a recording to a notice";
    case "notice.delete":
      return "took a notice down";
    case "calls.export":
      return "exported the call log";
    case "recording.update":
      return d?.enabled ? "turned call recording on" : "turned call recording off";
    case "recording.delete":
      return "deleted a call recording";
    case "line.address":
      return `set a public line's address to ${s("to")}`;
    case "line.enable":
      return `made ${s("address")} public (confirmed the warning)`;
    case "line.disable":
      return `turned public line ${s("address")} off`;
    case "line.update":
      return "changed a public line's settings";
    case "line.delete":
      return `removed public line ${s("handle")}`;
    case "line.greeting":
      return "changed a public line's greeting";
    case "line.block":
      return `blocked ${s("value")} from the public lines`;
    case "line.unblock":
      return `unblocked ${s("value")}`;
    default:
      return action;
  }
}
