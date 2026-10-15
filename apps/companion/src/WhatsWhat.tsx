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
      "A simple desk phone with keys and a handset: an Open Lounge Phone (you can build one; the first boards are early prototypes), or a virtual phone, the same phone in a browser window.",
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
    means:
      "The people you've invited and your phones. A server can hold many households (the public hub holds everyone's); each one is private to its own people.",
  },
  {
    term: "Guardian",
    means:
      "Can manage the household's phones, people, quiet hours and settings. One guardian is the owner, who can hand the household on to another guardian.",
  },
  {
    term: "Contact",
    means:
      "Can call and be called by the phones they're allowed on, and by the other people in the household.",
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
    term: "Recovery code",
    means:
      "A one-time code you keep somewhere safe. With your handle, it gets you back in if you lose every passkey: you make a new passkey and get a new code.",
  },
  {
    term: "Add-on",
    means:
      "A service you call like a person, such as an assistant or a radio. You link it under Add-ons and it gets its own address (yourname+name@server): only you can call it there, and if it offers parts of itself to share, you choose who gets each. Calls with it are marked as an add-on's everywhere.",
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
