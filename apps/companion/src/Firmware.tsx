import { useState } from "react";
import type { Api, DeviceSummary } from "./api.ts";
import { buildOrigin, phoneOf } from "./firmwareText.ts";
import { formatWhen } from "./text.ts";

/**
 * A hardware phone's firmware: what it runs, official or built at home, since when. On a kids'
 * phone, for its guardians: Ask me first, and while it waits, Allow or Remove and wipe.
 */
export function FirmwareCard({
  api,
  device,
  guardian,
  onChanged,
  onRemoved,
}: {
  api: Api;
  device: DeviceSummary;
  guardian: boolean;
  onChanged(): void;
  onRemoved(): void;
}) {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string>();
  const kids = device.mode === "kids" && device.askFirst !== undefined;
  const build = device.build;
  const now = Date.now();

  const act = async (fn: () => Promise<unknown>, after: () => void) => {
    setError(undefined);
    setBusy(true);
    try {
      await fn();
      after();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card stack">
      {kids && device.held && guardian && (
        <div className="confirm stack" role="alert">
          <p className="small">
            <strong>{phoneOf(device.name)} is waiting for your OK.</strong> It started running
            firmware built at home
            {build ? `: '${build.label}', ${formatWhen(build.since, now)}` : ""}. Until you allow
            it, nobody can call it and it calls only its grown-ups.
          </p>
          {confirming ? (
            <div className="row">
              <button type="button" onClick={() => setConfirming(false)} disabled={busy}>
                Keep it
              </button>
              <button
                type="button"
                className="danger"
                disabled={busy}
                onClick={() => void act(() => api.removeDevice(device.id), onRemoved)}
              >
                {busy ? "Removing…" : "Remove and wipe"}
              </button>
            </div>
          ) : (
            <div className="row">
              <button
                type="button"
                disabled={busy}
                onClick={() => void act(() => api.allowFirmware(device.id), onChanged)}
              >
                {busy ? "Allowing…" : "Allow"}
              </button>
              <button type="button" className="link danger" onClick={() => setConfirming(true)}>
                Remove and wipe
              </button>
            </div>
          )}
        </div>
      )}
      <dl className="phone-facts small">
        <dt>Firmware</dt>
        <dd>
          {build ? (
            <>
              <strong>{build.label}</strong> · {buildOrigin(build.official)} · since{" "}
              {formatWhen(build.since, now)}
            </>
          ) : (
            "Not reported yet: it shows here once the phone connects."
          )}
        </dd>
      </dl>
      {kids && guardian && (
        <>
          <label className="row">
            <input
              type="checkbox"
              checked={device.askFirst ?? true}
              disabled={busy}
              onChange={(e) => {
                const on = e.target.checked;
                void act(() => api.setAskFirst(device.id, on), onChanged);
              }}
            />
            <span>Ask me first</span>
          </label>
          <p className="hint">
            When this phone starts running firmware that isn't an official update, you hear about it
            right away. With Ask me first it also waits for your OK: until then it shows ASK A
            GROWN-UP, nobody can call it, and it calls only its grown-ups.
          </p>
        </>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
