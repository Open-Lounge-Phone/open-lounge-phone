// The phone's speed-dial keys, in pages of ten (one key per digit). One page looks as it always
// has; "Add page" makes room for ten more, and BACK on the phone (handset up) turns to them.
import { useState } from "react";
import type { ContactEntry } from "./api.ts";
import { SPEED_DIAL_ROWS, slotOf } from "./keyLabels.ts";
import { keyIndexOf, keyName, lastUsedPage, moveKey, pageEmpty } from "./speedDialPages.ts";

const DIGITS = SPEED_DIAL_ROWS.flat();

export function KeyPages({
  buttons,
  contacts,
  maxPages,
  onSet,
  onMove,
}: {
  /** Who is on each key, by stored index ((page - 1) * 10 + slot). */
  buttons: Record<string, string>;
  contacts: ContactEntry[];
  /** How many pages this phone may have. */
  maxPages: number;
  onSet(index: number, userId: string | null): void;
  onMove(changes: { index: number; userId: string | null }[]): void;
}) {
  const [added, setAdded] = useState(1);
  const pages = Math.min(Math.max(lastUsedPage(buttons), added), Math.max(1, maxPages));
  const paged = pages > 1;
  const byId = new Map(contacts.map((c) => [c.id, c]));

  const keyGrid = (page: number) => (
    <div className={paged ? "keys" : "card keys"}>
      {DIGITS.map((digit) => {
        const index = keyIndexOf(page, slotOf(digit));
        const assigned = buttons[String(index)] ?? "";
        const name = keyName(index, paged);
        return (
          <label key={digit} className="key-row">
            <span className="keycap" title={name}>
              {digit}
            </span>
            <select
              aria-label={name}
              value={assigned}
              onChange={(e) => onSet(index, e.target.value || null)}
            >
              <option value="">— nobody —</option>
              {contacts.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                  {c.deviceCanCall ? "" : " (can't be called)"}
                </option>
              ))}
            </select>
          </label>
        );
      })}
    </div>
  );

  return (
    <div className="stack">
      {paged
        ? Array.from({ length: pages }, (_, i) => i + 1).map((page) => (
            <fieldset key={page} className="card stack key-page">
              <legend>Page {page}</legend>
              {page > 1 && pageEmpty(buttons, page) && (
                <p className="muted small">Nobody on this page yet: the phone skips empty pages.</p>
              )}
              {keyGrid(page)}
            </fieldset>
          ))
        : keyGrid(1)}
      {pages < maxPages && (
        <div className="row wrap">
          <button type="button" onClick={() => setAdded(pages + 1)}>
            Add page
          </button>
          <span className="muted small">
            {paged
              ? `Ten more keys. Up to ${maxPages} pages.`
              : "More than ten people? Add a page: with the handset up, BACK turns to it."}
          </span>
        </div>
      )}
      {paged && (
        <MoveKey
          buttons={buttons}
          pages={pages}
          label={(id) => byId.get(id)?.label ?? "Someone"}
          onMove={onMove}
        />
      )}
    </div>
  );
}

/** Move someone to another key (on any page); whoever is there swaps places with them. */
function MoveKey({
  buttons,
  pages,
  label,
  onMove,
}: {
  buttons: Record<string, string>;
  pages: number;
  label(id: string): string;
  onMove(changes: { index: number; userId: string | null }[]): void;
}) {
  const assigned = Object.entries(buttons)
    .filter(([, id]) => id)
    .map(([k, id]) => ({ index: Number(k), id }))
    .sort((a, b) => a.index - b.index);
  const [from, setFrom] = useState<number>();
  const [page, setPage] = useState(1);
  const [slot, setSlot] = useState(0);
  if (!assigned.length) return null;
  const source = from ?? assigned[0]?.index ?? 0;
  const to = keyIndexOf(page, slot);
  const there = buttons[String(to)];
  return (
    <form
      className="card stack"
      onSubmit={(e) => {
        e.preventDefault();
        if (to !== source) onMove(moveKey(buttons, source, to));
      }}
    >
      <span className="small muted">Move someone to another key</span>
      <div className="row wrap">
        <label>
          <span className="muted small">Who</span>
          <select value={source} onChange={(e) => setFrom(Number(e.target.value))}>
            {assigned.map((a) => (
              <option key={a.index} value={a.index}>
                {label(a.id)} ({keyName(a.index, true).toLowerCase()})
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="muted small">To page</span>
          <select value={page} onChange={(e) => setPage(Number(e.target.value))}>
            {Array.from({ length: pages }, (_, i) => i + 1).map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="muted small">Key</span>
          <select value={slot} onChange={(e) => setSlot(Number(e.target.value))}>
            {DIGITS.map((d) => {
              const id = buttons[String(keyIndexOf(page, slotOf(d)))];
              return (
                <option key={d} value={slotOf(d)}>
                  {d}
                  {id ? ` (${label(id)})` : " (free)"}
                </option>
              );
            })}
          </select>
        </label>
        <button type="submit">{there && to !== source ? "Swap" : "Move"}</button>
      </div>
      {to === source && <span className="hint">They're on that key already.</span>}
    </form>
  );
}
