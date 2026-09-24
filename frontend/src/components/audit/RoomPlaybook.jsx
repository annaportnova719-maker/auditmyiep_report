import { useI18n } from '@/lib/i18n';

// The dark-teal "How to use this in the room" playbook.
export default function RoomPlaybook() {
  const { t } = useI18n();
  return (
    <div className="rounded-3xl bg-primary p-6 sm:p-9 text-primary-foreground shadow-sm">
      <h2 className="font-heading text-2xl font-700">{t('report.roomTitle')}</h2>
      <p className="mt-3 text-primary-foreground/85 leading-relaxed">
        Case managers and teachers often talk in circles, stay vague, and run out the clock. Three rules keep you in control — and every card below hands you the exact questions.
      </p>

      <p className="mt-5 font-700 text-white">Rule 1 — Ask questions, not statements.</p>
      <p className="mt-1 text-primary-foreground/85 leading-relaxed">
        People can nod past a statement and move on. A direct question demands an answer, and their answer (or their silence) becomes your record. When they go quiet after you make a point, turn it into a question.
      </p>

      <p className="mt-5 font-700 text-white">Rule 2 — Escalate in three gears — only as far as you need.</p>
      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <div className="rounded-2xl bg-card border border-border p-4">
          <div className="flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-gold text-primary font-700 text-sm">1</span>
            <div className="font-600 text-card-foreground text-sm">Ask for specificity (warm)</div>
          </div>
          <p className="mt-2 text-sm text-card-foreground/80">"Can you help me understand exactly how this will work — who does it, how often, and where?"</p>
        </div>
        <div className="rounded-2xl bg-card border border-border p-4">
          <div className="flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-gold text-primary font-700 text-sm">2</span>
            <div className="font-600 text-card-foreground text-sm">Ask for data &amp; measurement</div>
          </div>
          <p className="mt-2 text-sm text-card-foreground/80">"What data or measurement will show it's working, and how and when will I see it?"</p>
        </div>
        <div className="rounded-2xl bg-card border border-border p-4">
          <div className="flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-gold text-primary font-700 text-sm">3</span>
            <div className="font-600 text-card-foreground text-sm">The legal accountability question</div>
          </div>
          <p className="mt-2 text-sm text-card-foreground/80">Name the standard, ask a question they must answer — then ask for Prior Written Notice, which turns a refusal into a required legal record.</p>
        </div>
      </div>

      <p className="mt-5 font-700 text-white">Rule 3 — Turn a refusal into a record.</p>
      <p className="mt-1 text-primary-foreground/85 leading-relaxed">
        If they won't fix something, your closing question is: <em>"Will the team please issue Prior Written Notice documenting what's being declined and why?"</em> A PWN is legally required (34 CFR §300.503). Asking for it calmly tells them you know the process and creates the paper trail.
      </p>

      <div className="mt-5 rounded-2xl bg-gold-soft border border-gold/50 p-4">
        <div className="font-700 text-foreground">🛑 Last resort — use only if nothing is moving</div>
        <p className="mt-2 text-sm text-foreground/85 leading-relaxed">
          Reach for these <b>only</b> if they won't budge and won't compromise toward an agreement — when an issue is truly worth taking all the way to the top. Used too early they harden the room; held for the right moment, they signal you know exactly where this can go. Procedural, never threats.
        </p>
        <ul className="mt-2 space-y-1 text-sm text-foreground/85 list-disc pl-5">
          <li>"What's the district's process when a parent believes the IEP isn't being written to legal standards?"</li>
          <li>"Can you point me to the procedural safeguards, and who I'd contact at the state if we can't resolve this here?"</li>
          <li>"Who is the district's next point of contact above this team?"</li>
        </ul>
      </div>

      <div className="mt-4 rounded-2xl bg-gold-soft border border-gold/40 p-4">
        <div className="font-700 text-foreground">✋ Before you sign anything</div>
        <p className="mt-2 text-sm text-foreground/85 leading-relaxed">
          If an issue is still unresolved, <b>don't sign in a way that looks like agreement.</b> Schools often say "it's just signing that you attended" or "we can change it anytime" — but your signature can later be pointed to as agreement, and once the IEP is finalized, <b>every change has to go through the amendment + Prior Written Notice process</b>, which is far harder than getting the language right now, in the room.
        </p>
        <p className="mt-2 text-sm font-600 text-foreground">If something's still open, you can:</p>
        <ul className="mt-1 space-y-1 text-sm text-foreground/85 list-disc pl-5">
          <li>Ask for time to review the final draft before signing.</li>
          <li>Sign only as <b>"attended — do not agree with [the open items],"</b> or decline to sign and put your disagreement in writing.</li>
          <li>Say: <i>"I'm not comfortable finalizing until we resolve [X]. I'd rather keep this open and get it right than amend it later."</i></li>
        </ul>
        <p className="mt-2 text-xs text-foreground/70 leading-relaxed">
          Note: for an annual IEP the district may still implement after giving you Prior Written Notice, so not signing preserves your position and your record rather than blocking the plan; for <b>initial</b> services your consent is required. If it's high-stakes, loop in PEAK Parent Center or a special-education attorney. Not legal advice.
        </p>
      </div>
    </div>
  );
}
