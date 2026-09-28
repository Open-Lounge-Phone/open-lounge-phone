import { useState } from "react";
import { shareLink, virtualPhoneUrl } from "./phoneLed.ts";

interface Props {
  householdName: string;
  meId: string;
  userName: string;
  /** Called when a virtual phone is being added (so the app watches for it to pair). */
  onAddingPhone(): void;
  /** "I have an Open Lounge Phone": pair it with a code. */
  onPairHardware(): void;
  onDone(): void;
}

/** Two short, skippable steps after joining or setting up: what's what, then get a phone. */
export function Welcome({
  householdName,
  meId,
  userName,
  onAddingPhone,
  onPairHardware,
  onDone,
}: Props) {
  const [step, setStep] = useState<1 | 2>(1);
  const [note, setNote] = useState<string>();

  const addVirtual = () => {
    onAddingPhone();
    window.open(virtualPhoneUrl(meId, userName, true), `olp-phone-${meId}`);
    onDone();
  };
  const elsewhere = async () => {
    const url = shareLink(location.origin, meId, userName);
    try {
      if (navigator.share) await navigator.share({ title: "My Open Lounge Phone", url });
      else {
        await navigator.clipboard.writeText(url);
        setNote("Link copied — open it on your computer or tablet and leave it open.");
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") setNote(url);
    }
  };

  return (
    <section className="stack welcome" aria-label="Welcome">
      <p className="muted small">Step {step} of 2</p>
      {step === 1 ? (
        <>
          <h2>Welcome to {householdName}</h2>
          <div className="card stack">
            <div>
              <strong>This app</strong>
              <p className="muted small">
                Call and get calls here. You're reachable while it's open.
              </p>
            </div>
            <div>
              <strong>A phone</strong>
              <p className="muted small">
                A simple desk phone with keys and a handset. The hardware isn't finished yet, so you
                can use a virtual phone in a browser.
              </p>
            </div>
          </div>
          <div className="row">
            <button type="button" className="link" onClick={onDone}>
              Skip
            </button>
            <button type="button" className="primary" onClick={() => setStep(2)}>
              Next
            </button>
          </div>
        </>
      ) : (
        <>
          <h2>Get a phone</h2>
          <div className="card stack choice-card recommended">
            <div>
              <strong>Set up a virtual phone</strong> <span className="badge">Recommended</span>
              <p className="muted small">
                Open it in a browser window on your computer or an always-on device like a tablet,
                and leave it open — it works like a desk phone.
              </p>
            </div>
            <button type="button" className="primary" onClick={addVirtual}>
              Add my virtual phone here
            </button>
            <button type="button" onClick={() => void elsewhere()}>
              Open it on another device
            </button>
            {note && <p className="hint">{note}</p>}
          </div>
          <div className="card stack choice-card">
            <strong>Just use the app for now</strong>
            <p className="muted small">You can add a phone any time from Home.</p>
            <button type="button" onClick={onDone}>
              Use the app
            </button>
          </div>
          <div className="card stack choice-card">
            <strong>I have an Open Lounge Phone</strong>
            <p className="muted small">Lift its handset — it reads out a code to pair it.</p>
            <button
              type="button"
              onClick={() => {
                onDone();
                onPairHardware();
              }}
            >
              Pair my phone
            </button>
          </div>
        </>
      )}
    </section>
  );
}
