import { KEY_ROWS, slotOf } from "./keypad.ts";
import type { DeviceConfig } from "./leds.ts";
import type { MenuView } from "./menu.ts";

/**
 * Labels for the status display's key map: two rows in the same order as the keys
 * (1 2 3 4 5 MENU / 6 7 8 9 0 BACK). Representational — the display is narrower than the key
 * rows, so it mirrors their order rather than sitting beside each key. Pure.
 */
export function keyGrid(config: DeviceConfig | undefined, menu?: MenuView): string[][] {
  const bySlot = new Map((config?.buttons ?? []).map((b) => [b.index, b.label]));
  return KEY_ROWS.map((row) =>
    row.map((key) => {
      if (key === "menu") return menu ? menu.menuLabel : "Menu";
      if (key === "back") return menu ? menu.backLabel : "Back";
      const digit = Number(key);
      return menu ? (menu.labels[digit] ?? "") : (bySlot.get(slotOf(digit)) ?? "");
    }),
  );
}
