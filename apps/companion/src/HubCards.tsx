import { useEffect, useState } from "react";
import type { Api, HubInfo, UsageInfo } from "./api.ts";
import { CREDIT, fairUseLines, fundingLines } from "./hubText.ts";

/** Your fair-use allowance this month (only on servers that have one). */
export function FairUseCard({ api }: { api: Api }) {
  const [usage, setUsage] = useState<UsageInfo>();
  useEffect(() => {
    api.usage().then(setUsage, () => {});
  }, [api]);
  const lines = usage ? fairUseLines(usage) : [];
  if (!usage || lines.length === 0) return null;
  return (
    <section className="card stack fair-use" aria-labelledby="fair-use-title">
      <h3 id="fair-use-title">Fair use this month</h3>
      <ul className="small">
        {lines.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
      <p className="hint">
        Free, with a generous allowance so the hub stays fair for everyone. It resets on{" "}
        {usage.resetsOn}. Calls in progress are never cut off.
      </p>
    </section>
  );
}

/** How the public hub is funded, and the Sponsor button (hidden until there's a link). */
export function FundingCard({ api }: { api: Api }) {
  const [hub, setHub] = useState<HubInfo>();
  useEffect(() => {
    api.hubInfo().then(setHub, () => {});
  }, [api]);
  const lines = hub ? fundingLines(hub) : [];
  if (!hub || (lines.length === 0 && !hub.sponsorUrl)) return null;
  return (
    <section className="card stack funding" aria-labelledby="funding-title">
      <h3 id="funding-title">Free, funded by donations</h3>
      {lines.length > 0 && (
        <ul className="small">
          {lines.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      )}
      <p className="hint">
        Most calls go straight between the two people, so running the hub costs little. For full
        control of your data and keys, you can run your own server — it still reaches everyone.
      </p>
      {hub.sponsorUrl && (
        <a className="button primary" href={hub.sponsorUrl} target="_blank" rel="noopener">
          Sponsor the hub
        </a>
      )}
    </section>
  );
}

/** The project credit (About / footer). */
export function Credit() {
  return (
    <p className="credit small muted">
      <a href={CREDIT.url} target="_blank" rel="noopener">
        {CREDIT.text}
      </a>
    </p>
  );
}
