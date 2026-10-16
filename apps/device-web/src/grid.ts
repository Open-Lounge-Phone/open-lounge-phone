import { keyPlace } from "@openloungephone/core";
import { KEY_ROWS, slotOf } from "./keypad.ts";
import type { DeviceConfig } from "./leds.ts";
import type { MenuView } from "./menu.ts";

/** The keys on one page (1 = `config.buttons`), each `index` its digit's slot. */
export function pageKeys(config: DeviceConfig | undefined, page = 1): DeviceConfig["buttons"] {
  if (page === 1) return config?.buttons ?? [];
  return config?.pages?.find((p) => p.page === page)?.buttons ?? [];
}

/** A key by its stored index ((page - 1) * 10 + slot), e.g. the one being called. */
export function keyAt(config: DeviceConfig | undefined, index: number) {
  const { page, slot } = keyPlace(index);
  return pageKeys(config, page).find((b) => b.index === slot);
}

/**
 * Labels for the status display's key map: two rows in the same order as the keys
 * (1 2 3 4 5 MENU / 6 7 8 9 0 BACK). Representational — the display is narrower than the key
 * rows, so it mirrors their order rather than sitting beside each key. Pure.
 */
export function keyGrid(config: DeviceConfig | undefined, menu?: MenuView, page = 1): string[][] {
  const bySlot = new Map(pageKeys(config, page).map((b) => [b.index, b.label]));
  return KEY_ROWS.map((row) =>
    row.map((key) => {
      if (key === "menu") return menu ? menu.menuLabel : "Menu";
      if (key === "back") return menu ? menu.backLabel : "Back";
      const digit = Number(key);
      return menu ? (menu.labels[digit] ?? "") : (bySlot.get(slotOf(digit)) ?? "");
    }),
  );
}
