import { useEffect, useState } from "react";
import type { Api, HomeFeatures } from "./api.ts";

/**
 * A phone's home features (Manage phone): a daily check-in, a chime ("Dinner's ready") and the
 * house intercom. Each is off until turned on here.
 */
export function HomeFeaturesCard({ api, deviceId }: { api: Api; deviceId: string }) {
  const [h, setH] = useState<HomeFeatures>();
  const [time, setTime] = useState("10:00");
  const [words, setWords] = useState("");
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState<string>();
  useEffect(() => {
    api.homeFeatures(deviceId).then(
      (x) => {
        setH(x);
        if (x.checkinBy) setTime(x.checkinBy);
        setWords(x.chimeText ?? "");
      },
      (e) => setError((e as Error).message),
    );
  }, [api, deviceId]);
  const save = async (patch: Partial<HomeFeatures>, what: string) => {
    setError(undefined);
    setSaved(undefined);
    try {
      const next = await api.setHomeFeatures(deviceId, patch);
      setH(next);
      setWords(next.chimeText ?? "");
      setSaved(what);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  if (!h) return error ? <p className="error">{error}</p> : null;
  return (
    <div className="card stack">
      <label className="row">
        <input
          type="checkbox"
          checked={h.checkinBy !== null}
          onChange={(e) =>
            void save({ checkinBy: e.target.checked ? time : null }, "Daily check-in saved.")
          }
        />
        <span>Daily check-in by</span>
        <input
          type="time"
          value={time}
          onChange={(e) => {
            setTime(e.target.value);
            if (h.checkinBy !== null && e.target.value) {
              void save({ checkinBy: e.target.value }, "Daily check-in saved.");
            }
          }}
        />
      </label>
      <p className="hint">
        The phone asks “I'm OK” each day. If nobody presses 1 by then, the guardians get an alert,
        even if the phone is unplugged.
      </p>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void save({ chimeText: words.trim() || null }, "Chime saved.");
        }}
      >
        <label className="stack">
          <span>Chime (MENU 4 on the phone sends it to every phone here)</span>
          <textarea
            rows={2}
            maxLength={33}
            value={words}
            placeholder="Off"
            onChange={(e) => setWords(e.target.value)}
          />
        </label>
        <p className="hint">Up to two lines of 16 characters, e.g. “Dinner's ready”.</p>
        <button type="submit">Save chime</button>
      </form>
      <label className="row">
        <input
          type="checkbox"
          checked={h.intercom}
          onChange={(e) => void save({ intercom: e.target.checked }, "House intercom saved.")}
        />
        <span>House intercom</span>
      </label>
      <p className="hint">
        Calls this space's other phones with it on, room to room on the same Wi-Fi, without the
        internet. Only this space's phones can hear or ring it. Phones only, not the browser phone.
      </p>
      {saved && (
        <p className="ok" role="status">
          {saved}
        </p>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
