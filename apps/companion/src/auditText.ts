/** A space's audit trail in words ("changed quiet hours"). Pure. */
import { zoneLabel } from "./timeZones.ts";

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
      return `changed the time zone to ${zoneLabel(s("to"))} (was ${zoneLabel(s("from"))})`;
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
    case "phone.firmware.update":
      return `updated itself to ${s("to")}`;
    case "phone.firmware.change":
      return `started running firmware built at home: ${s("to")}${d?.held ? ", waiting for a grown-up's OK" : ""}`;
    case "phone.firmware.allow":
      return `allowed the new firmware on ${phone}`;
    case "phone.ask_first":
      return `turned ${d?.on ? "on" : "off"} Ask me first on ${phone}`;
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
      return s("address").includes("+")
        ? `put add-on ${s("address")} on ${phone}`
        : `put public line ${s("address")} on ${phone}`;
    case "addon.link": {
      const n = typeof d?.allowed === "number" ? d.allowed : 0;
      return `linked add-on ${s("name")}${n ? ` (${n} ${n === 1 ? "connection" : "connections"} may talk to it)` : ""}`;
    }
    case "addon.allow": {
      const n = typeof d?.allowed === "number" ? d.allowed : 0;
      return n
        ? `let ${n} ${n === 1 ? "connection" : "connections"} talk to add-on ${s("name")}`
        : `made add-on ${s("name")} theirs alone`;
    }
    case "addon.remove":
      return `removed add-on ${s("name")}`;
    case "addon.grant":
      return `gave ${s("label")} of add-on ${s("name")} to ${s("to")}`;
    case "addon.revoke":
      return `took ${s("share")} of add-on ${s("name")} back from ${s("from")}`;
    case "addon.share.request":
      return `asked add-on ${s("name")} for a new share, ${s("label")}`;
    case "addon.share.created":
      return `add-on ${s("name")} made ${s("label")}`;
    case "addon.share.refused":
      return `add-on ${s("name")} didn't make ${s("label")}`;
    case "addon.share.timeout":
      return `add-on ${s("name")} didn't answer about ${s("label")}`;
    case "addon.share.offline":
      return `add-on ${s("name")} was offline when asked for ${s("label")}`;
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
