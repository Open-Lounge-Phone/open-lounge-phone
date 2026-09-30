/**
 * How this phone is used (first-run choice, or `?variant=`): a kids' phone, someone's own desk
 * phone (`personal`), or a shared Lounge phone. Only the Lounge phone needs a stronger charger.
 */
export type Variant = "kids" | "personal" | "lounge";

/** USB-C source advertisement as read from the CC pins (USB-A chargers always read "default"). */
export type PowerSource = "default" | "1.5A" | "3A";

/**
 * The power-source policy reported in `status.power`: a Lounge phone on a Default USB source
 * reports reduced mode. (The minimal board, hardware/DESIGN.md §2, draws under 500 mA and runs
 * fully on any USB source; the policy stays for boards with heavier loads.) Kids works on
 * anything.
 */
export function powerStatus(variant: Variant, source: PowerSource) {
  return { source, reduced: variant === "lounge" && source === "default" };
}

export function parseVariant(v: string | null): Variant {
  return v === "lounge" || v === "personal" ? v : "kids";
}
