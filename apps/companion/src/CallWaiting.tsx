import { useEffect, useState } from "react";
import type { Api } from "./api.ts";

/**
 * Call waiting on or off: yours (your apps and own phones follow it), or a household phone's
 * (`deviceId`, its guardians). On unless turned off.
 */
export function CallWaitingToggle({ api, deviceId }: { api: Api; deviceId?: string }) {
  const [on, setOn] = useState<boolean>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    api.callWaiting(deviceId).then(setOn, (e) => setError((e as Error).message));
  }, [api, deviceId]);
  if (on === undefined && !error) return null;
  return (
    <div className="card stack">
      <label className="row">
        <input
          type="checkbox"
          checked={on ?? true}
          onChange={(e) => {
            const next = e.target.checked;
            setOn(next);
            api.setCallWaiting(next, deviceId).catch((err) => {
              setOn(!next);
              setError((err as Error).message);
            });
          }}
        />
        <span>Call waiting</span>
      </label>
      <p className="hint">
        {deviceId
          ? "A second call while this phone is in a call beeps softly instead of hearing busy. Taking it puts the first call on hold."
          : "A second call while you're in a call rings softly instead of hearing busy: answer it (your call goes on hold) or let it go to voicemail."}
      </p>
      {error && <p className="error">{error}</p>}
    </div>
  );
}
