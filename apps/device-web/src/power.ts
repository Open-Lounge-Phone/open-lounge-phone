/**
 * How this phone is used (first-run choice, or `?variant=`): a kids' phone, someone's own desk
 * phone (`personal`), or a shared Lounge phone. Only the Lounge phone needs a stronger charger.
 */
export type Variant = "kids" | "personal" | "lounge";

/** USB-C source advertisement as read from the CC pins (USB-A chargers always read "default"). */
export type PowerSource = "default" | "1.5A" | "3A";

/**
 * Mirrors the firmware policy in hardware/DESIGN.md §9.2a: the Lounge phone needs a ≥1.5 A
 * source for full features and runs in reduced mode (radar off, dimmer LEDs, quieter ringer)
 * on a Default source. Kids works on anything.
 */
export function powerStatus(variant: Variant, source: PowerSource) {
  return { source, reduced: variant === "lounge" && source === "default" };
}

export function parseVariant(v: string | null): Variant {
  return v === "lounge" || v === "personal" ? v : "kids";
}
