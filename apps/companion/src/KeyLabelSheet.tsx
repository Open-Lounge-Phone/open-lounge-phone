import { useState } from "react";
import { keyLabels, LABEL_MM, labelFontPt } from "./keyLabels.ts";

interface Props {
  buttons: Record<string, string>;
  contacts: { id: string; label: string }[];
  keyCount: number;
}

/**
 * For phones without a display (Kids Lite): print names to cut out and slip under clear
 * relegendable keycaps. Prints at true size; only the sheet is printed.
 */
export function KeyLabelSheet({ buttons, contacts, keyCount }: Props) {
  const [open, setOpen] = useState(false);
  const labels = keyLabels(buttons, contacts, keyCount);
  return (
    <div className="stack">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {open ? "Hide key labels" : "Print key labels"}
      </button>
      {open && (
        <div className="card stack">
          <p className="muted small">
            For phones without a display: print at 100 % scale, cut on the dashed lines and slip
            each label under its clear keycap. Labels are {LABEL_MM} mm square.
          </p>
          <div className="label-sheet" style={{ ["--label-mm" as string]: `${LABEL_MM}mm` }}>
            {labels.map((l) => (
              <div key={l.key} className="key-label">
                <span className="key-label__name" style={{ fontSize: `${labelFontPt(l.name)}pt` }}>
                  {l.name}
                </span>
                <span className="key-label__num">{l.key}</span>
              </div>
            ))}
          </div>
          <button type="button" className="primary" onClick={() => window.print()}>
            Print
          </button>
        </div>
      )}
    </div>
  );
}
