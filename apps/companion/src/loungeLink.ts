/** The link in a Lounge phone's QR code: `<server>/lounge#<deviceId>.<nonce>`. Pure. */
export interface LoungeLink {
  deviceId: string;
  nonce: string;
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;

export function parseLoungeLink(pathname: string, hash: string): LoungeLink | undefined {
  if (pathname.replace(/\/+$/, "") !== "/lounge") return undefined;
  const raw = hash.replace(/^#/, "");
  const dot = raw.lastIndexOf(".");
  if (dot <= 0) return undefined;
  const deviceId = raw.slice(0, dot);
  const nonce = raw.slice(dot + 1);
  if (!ID.test(deviceId) || !/^[A-Za-z0-9_-]{16,64}$/.test(nonce)) return undefined;
  return { deviceId, nonce };
}

/** Why a takeover didn't work, or why a session ended, in plain words. */
export function loungeReasonText(reason: string | undefined): string {
  switch (reason) {
    case "expired":
      return "That code has expired or was already used. Scan the code on the phone again.";
    case "wrong_key":
      return "That wasn't the flashing key. Scan the code on the phone again.";
    case "timeout":
      return "The key wasn't pressed in time. Scan the code on the phone again.";
    case "busy":
      return "The phone is in a call right now. Try again when it's free.";
    case "not_found":
      return "That phone isn't online in your household.";
    case "logout":
      return "You logged out on the phone.";
    case "left":
      return "You left the phone.";
    case "idle":
      return "The phone logged you out after sitting unused.";
    case "replaced":
      return "Someone else started using the phone.";
    case "offline":
      return "The phone went offline.";
    case "removed":
      return "You were removed from the household.";
    default:
      return "Something went wrong. Scan the code on the phone again.";
  }
}
