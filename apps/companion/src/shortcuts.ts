/** The call screen's keyboard shortcut: M mutes and unmutes (not while typing, nor with Ctrl/⌘/Alt). */
export function isMuteShortcut(e: {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  repeat?: boolean;
  target?: unknown;
}): boolean {
  if (e.key !== "m" && e.key !== "M") return false;
  if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return false;
  return !typing(e.target);
}

/** Whether a key went to a text field (or anything editable). */
function typing(target: unknown): boolean {
  const el = target as { tagName?: string; isContentEditable?: boolean; type?: string } | null;
  if (!el || typeof el !== "object") return false;
  if (el.isContentEditable) return true;
  const tag = (el.tagName ?? "").toUpperCase();
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag !== "INPUT") return false;
  // Buttons, checkboxes and sliders don't take letters.
  return !["button", "checkbox", "radio", "range", "submit", "reset"].includes(
    (el.type ?? "text").toLowerCase(),
  );
}
