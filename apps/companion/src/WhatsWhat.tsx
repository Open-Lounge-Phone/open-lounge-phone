import { Credit } from "./HubCards.tsx";
/** Plain-language glossary: what each thing in Open Lounge Phone is. */
export const TERMS: { term: string; means: string }[] = [
  {
    term: "This app",
    means: "Where you call people, get calls, and manage things. You're reachable while it's open.",
  },
  {
    term: "Phone",
    means:
      "A simple desk phone with keys and a handset. The hardware isn't finished yet, so you can use a virtual phone: the same phone, in a browser window.",
  },
  {
    term: "Virtual phone",
    means:
      "Open it in a browser on your computer or an always-on tablet and leave it open — it works like a desk phone. It's offline whenever its page is closed or hidden.",
  },
  {
    term: "Your phone",
    means: "A phone that belongs to you. Calls to you ring it (and this app).",
  },
  {
    term: "Household phone",
    means:
      "A shared phone, e.g. a kid's. It can only call and be called by the people on its allow-list.",
  },
  {
    term: "Household",
    means: "Everyone who's been invited to this server, plus its phones.",
  },
  {
    term: "Guardian",
    means: "Can manage phones, people and quiet hours.",
  },
  {
    term: "Contact",
    means: "Can call and be called by the phones they're allowed on, and by other people here.",
  },
  {
    term: "Available for calls",
    means:
      "When it's on, people can call you while your phone or this app is connected. Turn it off to stop calls without unplugging anything.",
  },
  {
    term: "Connections (buddies)",
    means:
      "Grown-ups you can call who aren't in your household — on this server or any other Open Lounge Phone server. You knock on their address (name@server); they accept, decline or block. Nobody can call you until you accept.",
  },
  {
    term: "Your address",
    means:
      "name@server — share it like a phone number written on paper. There's no directory, and no phone numbers: this network never connects to the phone system.",
  },
  {
    term: "Team or organization",
    means:
      "A space for grown-ups (a studio, a club, a venue) instead of a household: their own phones and shared Lounge phones, no kids' phones or quiet hours.",
  },
  {
    term: "Fair use",
    means:
      "On the free public hub, a generous monthly allowance (call minutes, voicemails, knocks) keeps things fair for everyone. Calls in progress are never cut off. Your own server has no limits.",
  },
  {
    term: "Quiet hours",
    means:
      "Times when household phones don't ring and can't call out; callers can leave a voicemail. Your own phone isn't affected.",
  },
];

export function WhatsWhat({ onBack }: { onBack(): void }) {
  return (
    <section className="stack">
      <button type="button" className="link back" onClick={onBack}>
        ← Back
      </button>
      <h2>What's what</h2>
      <dl className="card glossary">
        {TERMS.map((t) => (
          <div key={t.term}>
            <dt>{t.term}</dt>
            <dd>{t.means}</dd>
          </div>
        ))}
      </dl>
      <Credit />
    </section>
  );
}
