import { useState } from 'react';
import { MapPin, BookOpen, Loader2, Copy, Check } from 'lucide-react';
import { useI18n } from '@/lib/i18n';

const gradeStyles = {
  Strong: { pill: 'bg-good-bg text-good border-good/30' },
  'Needs work': { pill: 'bg-warn-bg text-warn border-warn/30' },
  Weak: { pill: 'bg-crit-bg text-crit border-crit/30' },
  Missing: { pill: 'bg-crit-bg text-crit border-crit/30' }
};

function gradeLabel(grade) {
  return grade || 'Needs work';
}

function barColor(score) {
  const s = Number(score) || 0;
  if (s >= 75) return 'hsl(var(--good))';
  if (s >= 50) return 'hsl(var(--warn))';
  return 'hsl(var(--crit))';
}

// A compact dashboard stat tile: label, big number, and a mini score bar, so
// each section opens with its key numbers at a glance before the detail.
function StatTile({ label, value, big }) {
  const has = value === 0 || Boolean(value);
  const v = has ? Math.max(0, Math.min(100, Number(value))) : null;
  const c = barColor(v == null ? 0 : v);
  return (
    <div className="rounded-xl border border-border bg-background/60 p-3">
      <div className="text-[11px] font-800 uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`mt-1 font-heading font-800 leading-none tnum ${big ? 'text-3xl' : 'text-2xl'}`} style={{ color: c }}>
        {v == null ? '—' : v}{v != null && <span className="text-sm font-700 text-muted-foreground">/100</span>}
      </div>
      <div className="mt-2 h-1.5 w-full rounded-full bg-muted overflow-hidden">
        <div className="h-full rounded-full transition-all duration-700" style={{ width: (v == null ? 0 : v) + '%', background: c }} />
      </div>
    </div>
  );
}

function BlockHead({ icon, label }) {
  return (
    <div className="flex items-center gap-2 text-[17px] font-800 uppercase tracking-wide text-primary">
      <span>{icon}</span>
      <span>{label}</span>
    </div>
  );
}

function Step({ n, label, text }) {
  if (!text) return null;
  return (
    <li className="flex gap-3">
      <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-gold text-primary font-700 text-xs">{n}</span>
      <div className="min-w-0">
        <div className="text-[17px] font-800 uppercase tracking-wide text-foreground/75">{label}</div>
        <p className="text-[15px] leading-relaxed text-foreground/85">{text}</p>
      </div>
    </li>
  );
}

// A small "Copy" button that puts plain text on the clipboard so a parent
// can paste it straight into an email to the IEP team with no cleanup.
// Shows a checkmark for a moment so it's clear the click worked.
function CopyButton({ text, label }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch (err) {
      // Clipboard API can be unavailable in some contexts — the text is
      // still right there on screen and selectable by hand either way.
    }
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="no-print inline-flex flex-shrink-0 items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 py-1 text-xs font-700 text-primary hover:bg-muted transition"
    >
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      {copied ? t('report.copied') : (label || t('report.copy'))}
    </button>
  );
}

// Normalize a field that may be a plain string OR an array of points into a
// clean list of points. Lets the report render dense narrative fields as
// scannable numbered lists a parent can reference in a meeting.
function toPoints(value) {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  if (typeof value === 'string') {
    return value
      .split(/\n+/)
      .map((s) => s.replace(/^[\-\u2022\d.)\s]+/, '').trim())
      .filter(Boolean);
  }
  return [];
}

// Turns the model IEP language into clean, numbered text for the clipboard so
// a parent can paste a tidy list straight into an email to the IEP team.
function modelLanguageCopyText(value) {
  const pts = toPoints(value);
  if (pts.length <= 1) return pts[0] || '';
  return pts.map((p, i) => `${i + 1}. ${p}`).join('\n');
}

// Renders a field as a single paragraph when it is one point, or a tidy
// numbered list when it is several — easy to scan and reference.
function Points({ value, className }) {
  const pts = toPoints(value);
  if (pts.length === 0) return null;
  if (pts.length === 1) return <p className={className}>{pts[0]}</p>;
  return (
    <ol className="mt-2 space-y-2.5">
      {pts.map((p, i) => (
        <li key={i} className="flex gap-2.5 text-[15px] leading-relaxed text-foreground/85">
          <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-700 text-primary">{i + 1}</span>
          <span className="min-w-0">{p}</span>
        </li>
      ))}
    </ol>
  );
}

// Plain-text assembly of everything a parent needs to put a request in
// writing for this one section — meant to be pasted directly into an
// email to the IEP team, or dropped into notes for a draft-IEP meeting.
// No markdown, no HTML — just clean lines.
function buildFullCopyText(section, detail) {
  const lines = [];
  lines.push(`${section?.section_name || 'This section'} — request for the IEP team`);
  lines.push('');
  const askPts = toPoints(detail?.what_to_ask_for);
  if (askPts.length) {
    lines.push('The change I am requesting:');
    askPts.forEach((p, i) => lines.push(askPts.length > 1 ? `${i + 1}. ${p}` : p));
    lines.push('');
  }
  const whyPts = toPoints(detail?.why_this_target);
  if (whyPts.length) {
    lines.push('Why this is right for my child:');
    whyPts.forEach((p, i) => lines.push(whyPts.length > 1 ? `${i + 1}. ${p}` : p));
    lines.push('');
  }
  if (section?.citation) {
    lines.push('The law behind it:');
    lines.push(`${section.legal_basis || ''} (${section.citation})`.trim());
    lines.push('');
  }
  const modelPts = toPoints(detail?.model_language);
  if (modelPts.length) {
    lines.push('Language I am asking be added to the IEP:');
    modelPts.forEach((p, i) => lines.push(modelPts.length > 1 ? `${i + 1}. ${p}` : p));
    lines.push('');
  }
  if (detail?.how_progress_is_tracked) {
    lines.push('How progress should be tracked:');
    lines.push(detail.how_progress_is_tracked);
  }
  return lines.join('\n').trim();
}

// section: the fast-overview fields (grade, what_we_found, your_move, ...).
// detailState: { status: 'idle'|'loading'|'success'|'error', data, error } —
// the deeper "Understand it & how to advocate" content. The parent
// (AuditReportView) fetches this automatically the moment this section's
// tab becomes active — there's no click-to-expand anymore, it's always
// shown. onExpand(true) is used only to retry after an error.
export default function SectionCard({ section, detailState, onExpand }) {
  const { t, lang } = useI18n();
  const style = gradeStyles[section.grade] || gradeStyles['Needs work'];
  const beginsLabel = lang === 'es' ? 'comienza p.' : 'begins p.';

  const status = detailState?.status || 'idle';
  const detail = detailState?.data || null;

  const services = Array.isArray(detail?.services_that_support_it) ? detail.services_that_support_it : [];
  const hasFinalAsk = Boolean(toPoints(detail?.what_to_ask_for).length || toPoints(detail?.why_this_target).length || section.citation);
  const hasTracking = Boolean(detail?.how_progress_is_tracked || services.length > 0);

  return (
    <div className="card rounded-2xl border border-border bg-card p-5 sm:p-6 shadow-brand">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <MapPin className="h-4 w-4 flex-shrink-0 text-primary" />
            <span>{beginsLabel} {section.page_number || '—'}</span>
          </div>
          <h2 className="mt-1 font-heading text-2xl font-800 leading-tight">{section.section_name}</h2>
        </div>
        <span className={`inline-flex flex-shrink-0 items-center rounded-full border px-3 py-1.5 text-sm font-800 ${style.pill}`}>
          {gradeLabel(section.grade)}
        </span>
      </div>

      {/* Dashboard tiles — the section’s numbers at a glance. */}
      <div className="mt-4 grid grid-cols-3 gap-2.5 sm:gap-3">
        <StatTile label="Section score" value={section.section_score} big />
        <StatTile label="Compliance" value={section.compliance_score} />
        <StatTile label="Enforceability" value={section.enforceability_score} />
      </div>

      <p className="mt-4 text-[15px] leading-relaxed text-foreground/85">
        <b>{t('report.whatFound')}:</b> {section.what_we_found}
      </p>

      <div className="mt-4 rounded-xl border border-gold/40 bg-gold-soft/70 p-4">
        <div className="text-[17px] font-800 uppercase tracking-wide text-gold">▸ {t('report.yourMove')}</div>
        <p className="mt-1 text-sm font-500 text-foreground">{section.your_move}</p>
      </div>

      {section.if_no_detail_yet && section.grade !== 'Strong' && (
        <div className="mt-3 rounded-xl border border-brand/30 bg-brand-soft/60 p-4">
          <div className="text-[17px] font-800 uppercase tracking-wide text-primary">🔎 {t('report.ifNoDetail')}</div>
          <p className="mt-1 text-[15px] leading-relaxed text-foreground/85">{section.if_no_detail_yet}</p>
        </div>
      )}

      <div className="mt-3 text-sm leading-relaxed text-foreground/75">
        {section.legal_basis}{' '}
        {section.citation && (
          <span className="ml-1 inline-flex items-center rounded-md bg-brand-soft px-2 py-0.5 text-xs font-600 text-primary">
            {section.citation}
          </span>
        )}
      </div>

      {/* Understand it & how to advocate — ALWAYS shown, no click required.
          Pink/rose background (reusing the app's existing --crit palette)
          so a parent can't scroll past it without noticing it's there. */}
      <div className="drawer mt-4 rounded-2xl border-2 border-crit/40 bg-card p-4 sm:p-5">
        <div className="flex items-center gap-2 text-[17px] font-800 uppercase tracking-wide text-crit">
          <BookOpen className="h-4 w-4" />
          {t('report.drawer')}
        </div>
        <p className="mt-1 text-xs leading-relaxed text-foreground/70">
          Everything you need for this section when you talk to the IEP team — in plain terms, then the exact questions and words to use.
        </p>

        <div className="drawer-body mt-4 space-y-4">
          {(status === 'loading' || status === 'idle') && (
            <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading the deeper breakdown for this section…
            </div>
          )}

          {status === 'error' && (
            <div className="rounded-lg border border-crit/40 bg-card p-3 text-sm text-foreground">
              {detailState?.error || 'Something went wrong loading this section.'}{' '}
              <button
                type="button"
                onClick={() => onExpand?.(true)}
                className="font-700 text-primary underline no-print"
              >
                Try again
              </button>
            </div>
          )}

          {status === 'success' && detail && (
            <>
              {/* 1. Understand it — two short, clearly separate boxes
                  instead of one dense paragraph. */}
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-lg border border-border bg-card p-3">
                  <BlockHead icon="📘" label={t('report.plainTerms')} />
                  <p className="mt-1.5 text-[15px] leading-relaxed text-foreground/85">{detail.in_plain_terms}</p>
                </div>
                <div className="rounded-lg border border-border bg-card p-3">
                  <BlockHead icon="⚠️" label={t('report.fallsShort')} />
                  <Points value={detail.why_it_falls_short} className="mt-1.5 text-[15px] leading-relaxed text-foreground/85" />
                </div>
              </div>

              {/* 2. The questions — a ladder, not three options. Each one
                  is built to pull a specific piece of information out of
                  the team, and only comes up if the last answer wasn't
                  good enough. */}
              <div className="rounded-lg border border-border bg-card p-3">
                <BlockHead icon="❓" label="Questions to ask — in this order" />
                <ol className="mt-3 space-y-3">
                  <Step n="1" label={t('report.askStart')} text={detail.ask_start} />
                  <Step n="2" label={t('report.askVague')} text={detail.ask_if_vague} />
                  <Step n="3" label={t('report.askStuck')} text={detail.ask_if_stuck} />
                </ol>
              </div>

              {/* 3. The final ask — the payoff of the whole section. What
                  to request, why THIS child needs it, and the law behind
                  it, all in one place a parent can point to. */}
              {hasFinalAsk && (
                <div className="rounded-xl border-2 border-primary bg-brand-soft/70 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <BlockHead icon="🎯" label="Your final ask" />
                    <CopyButton text={buildFullCopyText(section, detail)} label={t('report.copyAll')} />
                  </div>
                  <div className="mt-3 space-y-3">
                    {toPoints(detail.what_to_ask_for).length > 0 && (
                      <div>
                        <div className="text-[17px] font-800 uppercase tracking-wide text-foreground/75">The change to request</div>
                        <Points value={detail.what_to_ask_for} className="mt-0.5 text-[15px] leading-relaxed text-foreground/90" />
                      </div>
                    )}
                    {toPoints(detail.why_this_target).length > 0 && (
                      <div>
                        <div className="text-[17px] font-800 uppercase tracking-wide text-foreground/75">Why this fits this child</div>
                        <Points value={detail.why_this_target} className="mt-0.5 text-[15px] leading-relaxed text-foreground/90" />
                      </div>
                    )}
                    {section.citation && (
                      <div>
                        <div className="text-[17px] font-800 uppercase tracking-wide text-foreground/75">The law behind it</div>
                        <p className="mt-0.5 text-[15px] leading-relaxed text-foreground/90">
                          {section.legal_basis} <span className="font-600 text-primary">({section.citation})</span>
                        </p>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* 4. How it gets tracked, and what services back it up. */}
              {hasTracking && (
                <div className="rounded-lg border border-border bg-card p-3">
                  <BlockHead icon="📊" label="How progress gets tracked" />
                  {detail.how_progress_is_tracked && (
                    <p className="mt-1.5 text-[15px] leading-relaxed text-foreground/85">{detail.how_progress_is_tracked}</p>
                  )}
                  {services.length > 0 && (
                    <div className="mt-2">
                      <div className="text-[17px] font-800 uppercase tracking-wide text-foreground/75">{t('report.services')}</div>
                      <ul className="mt-1 space-y-1">
                        {services.map((s, idx) => (
                          <li key={idx} className="text-[15px] leading-relaxed text-foreground/85">• {s}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}

              {/* 5. The exact language, on its own, ready to paste. This is
                  the block a parent forwards into an email or drops into a
                  draft-IEP note before the next meeting. */}
              {toPoints(detail.model_language).length > 0 && (
                <div className="rounded-xl border-2 border-gold bg-gold-soft/60 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <BlockHead icon="📄" label={t('report.modelLanguage')} />
                    <CopyButton text={modelLanguageCopyText(detail.model_language)} />
                  </div>
                  <div className="mt-2 rounded-lg border border-border bg-card p-3">
                    <Points value={detail.model_language} className="text-[15px] leading-relaxed text-foreground/85" />
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
