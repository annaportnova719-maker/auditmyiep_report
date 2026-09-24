import { useState, useEffect, useCallback, useRef } from 'react';
import { Download, Mail, ChevronLeft, ChevronRight } from 'lucide-react';
import ScoreRing from '@/components/ScoreRing';
import SectionCard from '@/components/audit/SectionCard';
import RoomPlaybook from '@/components/audit/RoomPlaybook';
import { scoreTextColor } from '@/lib/scoreColors';
import { useI18n } from '@/lib/i18n';

const SECTION_DETAIL_URL = 'http://127.0.0.1:5001/api/section-detail';
const EMAIL_REPORT_URL = 'http://127.0.0.1:5001/api/email-report';
const REPORT_PDF_URL = 'http://127.0.0.1:5001/api/report-pdf';

function colorFor(score) {
  if (score >= 75) return 'var(--good)';
  if (score >= 50) return 'var(--warn)';
  return 'var(--crit)';
}

function dotColor(grade) {
  if (grade === 'Strong') return 'var(--good)';
  if (grade === 'Needs work') return 'var(--warn)';
  return 'var(--crit)'; // Weak / Missing
}

function SubBar({ label, score }) {
  return (
    <div>
      <div className="flex items-center justify-between text-sm">
        <span className="font-600 text-foreground/80">{label}</span>
        <span className="tnum text-lg font-800" style={{ color: scoreTextColor(score) }}>{score}</span>
      </div>
      <div className="mt-1 h-2.5 w-full rounded-full bg-muted">
        <div
          className="h-2.5 rounded-full transition-all duration-700"
          style={{ width: `${Math.max(0, Math.min(100, score))}%`, background: scoreTextColor(score) }}
        />
      </div>
    </div>
  );
}

export default function AuditReportView({ report, iepFile, title, meta, initialEmail }) {
  const { t } = useI18n();

  // 'overview' or a section index (as a number). This is what replaces the
  // old one-long-scroll layout — one panel visible at a time, picked from
  // the sidebar (or the Prev/Next buttons), like a real report app instead
  // of a single page you scroll through forever.
  const [activeTab, setActiveTab] = useState('overview');

  const [awaitingDownload, setAwaitingDownload] = useState(false);
  const [downloadError, setDownloadError] = useState('');
  const [awaitingEmail, setAwaitingEmail] = useState(false);

  const [emailAddress, setEmailAddress] = useState(initialEmail || '');
  const [marketingOptIn, setMarketingOptIn] = useState(false);
  const [emailStatus, setEmailStatus] = useState('idle'); // idle | sending | sent | error
  const [emailError, setEmailError] = useState('');

  // One entry per section, keyed by index: { status: 'idle'|'loading'|'success'|'error', data, error }.
  // This is the "Understanding More" deep-dive content — fetched lazily,
  // one section at a time, only once a parent actually opens that section
  // (or Print / Email a copy asks for everything at once).
  const [sectionDetails, setSectionDetails] = useState({});
  // ensureSectionDetail below is created once (its deps never change after
  // the report loads) and reads sectionDetails to decide whether a fetch is
  // already in flight. Without this ref it would always see the sectionDetails
  // from the render it was CREATED in — an empty {} — so it would never
  // recognize an already-loading/already-loaded section and would re-fetch
  // every section every time Print or Email was clicked, wastefully queuing
  // duplicate Claude calls behind each other. The ref always holds the
  // current value.
  const sectionDetailsRef = useRef(sectionDetails);
  useEffect(() => { sectionDetailsRef.current = sectionDetails; }, [sectionDetails]);

  // Defensive normalize: `sections` should always be an array, but on a
  // rare bad response Claude can write it as a JSON object with numeric
  // keys instead. The backend already repairs this, but this is a second
  // safety net so the report screen can never crash over it either way.
  const rawSections = report?.sections;
  const sections = Array.isArray(rawSections)
    ? rawSections
    : rawSections && typeof rawSections === 'object'
      ? Object.keys(rawSections).sort((a, b) => Number(a) - Number(b)).map((k) => rawSections[k])
      : [];
  const totalSections = sections.length;

  const ensureSectionDetail = useCallback(async (index, { force = false } = {}) => {
    const current = sectionDetailsRef.current[index];
    if (!force && current && (current.status === 'loading' || current.status === 'success')) {
      return;
    }
    if (!iepFile) {
      setSectionDetails((prev) => ({
        ...prev,
        [index]: {
          status: 'error',
          error: 'The original PDF isn’t available anymore (this usually happens after a page refresh, by design — this app never keeps a copy of your file). Go back and run the audit again to see this section’s detail.',
        },
      }));
      return;
    }

    setSectionDetails((prev) => ({ ...prev, [index]: { status: 'loading' } }));

    const section = sections[index];
    try {
      const formData = new FormData();
      formData.append('iep_pdf', iepFile);
      formData.append('section_name', section.section_name || '');
      formData.append('page_number', section.page_number || '');
      formData.append('grade', section.grade || '');
      formData.append('what_we_found', section.what_we_found || '');
      formData.append('your_move', section.your_move || '');

      const res = await fetch(SECTION_DETAIL_URL, { method: 'POST', body: formData });
      const data = await res.json();
      if (!res.ok) {
        setSectionDetails((prev) => ({ ...prev, [index]: { status: 'error', error: data.error || 'Something went wrong loading this section.' } }));
        return;
      }
      setSectionDetails((prev) => ({ ...prev, [index]: { status: 'success', data: data.detail } }));
    } catch (err) {
      setSectionDetails((prev) => ({ ...prev, [index]: { status: 'error', error: 'Could not reach the audit server. Is app.py running?' } }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [iepFile, sections]);

  // Auto-load a section's "Understand it & how to advocate" detail the
  // moment a parent lands on that section's tab — no click required. This
  // replaces the old click-to-expand drawer. Switching tabs back and forth
  // is cheap: ensureSectionDetail already skips the fetch if that section
  // is already loading or loaded.
  useEffect(() => {
    if (typeof activeTab === 'number') {
      ensureSectionDetail(activeTab);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  if (!report) return null;

  // "Settled" = either loaded or gave up with an error — not left hanging
  // in 'loading' forever. Print and Email both wait for every section to
  // settle before doing their final step, so neither one silently ships an
  // incomplete report if one section's detail failed to load.
  const allDetailsSettled = totalSections > 0
    && sections.every((_, i) => {
      const s = sectionDetails[i]?.status;
      return s === 'success' || s === 'error';
    });

  async function downloadReportPdf() {
    setDownloadError('');
    const detailsPayload = {};
    sections.forEach((_, i) => {
      if (sectionDetails[i]?.status === 'success') {
        detailsPayload[String(i)] = sectionDetails[i].data;
      }
    });
    try {
      const res = await fetch(REPORT_PDF_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ report, section_details: detailsPayload }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setDownloadError(data.error || 'Something went wrong building the PDF.');
        return;
      }
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'AuditMyIEP_Report.pdf';
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      setDownloadError('Could not reach the audit server. Is app.py running?');
    }
  }

  function handleDownload() {
    setDownloadError('');
    setAwaitingDownload(true);
    sections.forEach((_, i) => ensureSectionDetail(i));
  }

  async function sendEmail() {
    setEmailStatus('sending');
    setEmailError('');
    const detailsPayload = {};
    sections.forEach((_, i) => {
      if (sectionDetails[i]?.status === 'success') {
        detailsPayload[String(i)] = sectionDetails[i].data;
      }
    });
    try {
      const res = await fetch(EMAIL_REPORT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to_email: emailAddress,
          marketing_opt_in: marketingOptIn,
          report,
          section_details: detailsPayload,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setEmailError(data.error || 'Something went wrong sending that email.');
        setEmailStatus('error');
        return;
      }
      setEmailStatus('sent');
    } catch (err) {
      setEmailError('Could not reach the audit server. Is app.py running?');
      setEmailStatus('error');
    }
  }

  function handleEmailClick() {
    if (!emailAddress) return;
    setAwaitingEmail(true);
    sections.forEach((_, i) => ensureSectionDetail(i));
  }

  // Auto-email the full report once, on load, whenever we have the parent's
  // address. This fulfills the "emailed to you as a PDF" promise on the pay
  // button: the scored report shows on screen immediately, and in the
  // background every section detail loads (now cheap, via text extraction)
  // and the complete PDF is emailed. Fires exactly once per report.
  const autoSendTriggeredRef = useRef(false);

  useEffect(() => {
    if (autoSendTriggeredRef.current) return;
    const addr = (emailAddress || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr)) return;
    autoSendTriggeredRef.current = true;
    setAwaitingEmail(true);
    sections.forEach((_, i) => ensureSectionDetail(i));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (awaitingDownload && allDetailsSettled) {
      setAwaitingDownload(false);
      downloadReportPdf();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [awaitingDownload, allDetailsSettled]);

  useEffect(() => {
    if (awaitingEmail && allDetailsSettled) {
      setAwaitingEmail(false);
      sendEmail();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [awaitingEmail, allDetailsSettled]);

  const goToTab = (tab) => { setActiveTab(tab); window.scrollTo({ top: 0, behavior: 'smooth' }); };

  return (
    <div id="audit-report" className="print-full">
      {/* Mast */}
      <div className="rounded-3xl bg-card border border-border p-6 sm:p-8 shadow-brand">
        <div className="flex items-center gap-2 text-primary">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
              <path d="M12 2l8 4v6c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10V6l8-4z" stroke="currentColor" strokeWidth="1.5" />
              <path d="M9 12l2 2 4-4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
          <span className="font-heading text-lg font-700">AuditMyIEP</span>
        </div>
        <h1 className="mt-4 font-heading text-3xl sm:text-4xl font-800 leading-tight">{title}</h1>
        {meta && <div className="mt-2 text-sm text-muted-foreground">{meta}</div>}
      </div>

      {/* Scorecard */}
      <div className="mt-6 rounded-3xl bg-card border border-border p-6 sm:p-8 shadow-brand">
        <div className="flex flex-col items-center gap-8 sm:flex-row sm:items-center sm:gap-10">
          <ScoreRing score={report.overall_score} />
          <div className="min-w-0 flex-1">
            <div className="font-heading text-2xl font-700" style={{ color: colorFor(report.overall_score) }}>
              {report.verdict}
            </div>
            <p className="mt-2 text-sm leading-relaxed text-foreground/80">{report.summary}</p>
            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              <SubBar label={t('audit.sub.compliance')} score={report.compliance_score} />
              <SubBar label={t('audit.sub.enforce')} score={report.enforceability_score} />
            </div>
          </div>
        </div>
      </div>

      {/* Save-it-now — bold, not fine print. This report lives only in this
          browser tab: no account, no server copy, nothing saved anywhere. */}
      <div className="no-print mt-6 rounded-2xl border-2 border-gold bg-gold-soft p-5 sm:p-6">
        <p className="text-base font-800 font-heading text-foreground">⚠ Save this report before you leave this page</p>
        <p className="mt-1.5 text-sm leading-relaxed text-foreground/85">
          Nothing here is saved anywhere — not on this computer, not on a server. Close this tab without downloading or emailing it, and it's gone; getting it back means running the audit again.
        </p>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            onClick={handleDownload}
            disabled={awaitingDownload}
            className="inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-700 text-primary-foreground hover:opacity-90 transition disabled:opacity-60 disabled:cursor-not-allowed"
          >
            <Download className="h-4 w-4" />
            {awaitingDownload ? 'Loading every section…' : 'Download PDF report'}
          </button>
          {downloadError && (
            <p className="w-full text-sm font-600 text-crit">{downloadError}</p>
          )}
        </div>

        <div className="mt-4 rounded-xl border border-border bg-card p-4">
          <div className="flex items-center gap-2 text-sm font-700 text-foreground">
            <Mail className="h-4 w-4 text-primary" />
            Or email yourself a copy
          </div>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <input
              type="email"
              value={emailAddress}
              onChange={(e) => { setEmailAddress(e.target.value); setEmailStatus('idle'); }}
              placeholder="you@example.com"
              className="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <button
              type="button"
              onClick={handleEmailClick}
              disabled={!emailAddress || awaitingEmail || emailStatus === 'sending'}
              className="inline-flex items-center justify-center gap-2 rounded-lg border border-border bg-card px-4 py-2 text-sm font-700 text-foreground hover:bg-muted transition disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {awaitingEmail ? 'Preparing…' : emailStatus === 'sending' ? 'Sending…' : 'Email me a copy'}
            </button>
          </div>
          <label className="mt-2 flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
            <input
              type="checkbox"
              className="mt-0.5 h-3.5 w-3.5 flex-shrink-0"
              checked={marketingOptIn}
              onChange={(e) => setMarketingOptIn(e.target.checked)}
            />
            <span>Also send me occasional updates and tips from AuditMyIEP (optional — unrelated to your report).</span>
          </label>
          {emailStatus === 'sent' && (
            <p className="mt-2 text-sm font-600 text-good">Sent — check your inbox.</p>
          )}
          {emailStatus === 'error' && (
            <p className="mt-2 text-sm font-600 text-crit">{emailError}</p>
          )}
        </div>
      </div>

      {/* Section navigator — replaces the old one-long-scroll layout.
          Overview + one card per section, picked from this list instead of
          scrolling past all of them. */}
      <div className="mt-8 flex flex-col gap-6 lg:flex-row">
        <nav className="no-print lg:w-64 lg:flex-shrink-0">
          <div className="flex gap-2 overflow-x-auto pb-2 lg:flex-col lg:overflow-visible lg:pb-0 lg:sticky lg:top-4">
            <button
              onClick={() => goToTab('overview')}
              className={`flex-shrink-0 rounded-xl px-4 py-2.5 text-left text-sm font-700 transition ${activeTab === 'overview' ? 'bg-primary text-primary-foreground shadow-brand' : 'bg-card border border-border text-foreground hover:bg-muted'}`}
            >
              Overview
            </button>
            {sections.map((s, i) => (
              <button
                key={i}
                onClick={() => goToTab(i)}
                className={`flex flex-shrink-0 items-center gap-2 rounded-xl px-4 py-2.5 text-left text-sm font-600 transition ${activeTab === i ? 'bg-primary text-primary-foreground shadow-brand' : 'bg-card border border-border text-foreground hover:bg-muted'}`}
              >
                <span className="h-2 w-2 flex-shrink-0 rounded-full" style={{ background: activeTab === i ? 'currentColor' : dotColor(s.grade) }} />
                <span className="truncate max-w-[11rem]">{s.section_name}</span>
              </button>
            ))}
          </div>
        </nav>

        <div className="min-w-0 flex-1 space-y-6">
          {/* Overview panel */}
          <div className={`tab-panel space-y-6 ${activeTab === 'overview' ? '' : 'hidden'}`}>
            <div className="rounded-3xl bg-card border border-border p-6 sm:p-8 shadow-brand">
              <h2 className="font-heading text-2xl font-700">{t('report.headline')}</h2>
              <p className="mt-3 text-sm leading-relaxed text-foreground/85">
                <span className="font-700 text-good">{t('report.strengths')}:</span> {report.strengths}
              </p>
              <h3 className="mt-5 font-heading text-2xl font-800 text-crit">
                The {report.weak_points?.length || 0} {t('report.weakPoints')}:
              </h3>
              <ol className="mt-2 space-y-2.5">
                {(report.weak_points || []).map((w, i) => (
                  <li key={i} className="flex gap-3 text-sm leading-relaxed text-foreground/85">
                    <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-crit/15 text-crit text-xs font-700">{i + 1}</span>
                    <span>{w}</span>
                  </li>
                ))}
              </ol>
            </div>
            <RoomPlaybook />
          </div>

          {/* One panel per section */}
          {sections.map((s, i) => (
            <div key={i} className={`tab-panel ${activeTab === i ? '' : 'hidden'}`}>
              <SectionCard
                section={s}
                detailState={sectionDetails[i]}
                onExpand={(force) => ensureSectionDetail(i, { force })}
              />
              <div className="no-print mt-4 flex items-center justify-between">
                <button
                  onClick={() => goToTab(i === 0 ? 'overview' : i - 1)}
                  className="inline-flex items-center gap-1 text-sm font-700 text-primary hover:underline"
                >
                  <ChevronLeft className="h-4 w-4" /> {i === 0 ? 'Overview' : sections[i - 1].section_name}
                </button>
                {i < totalSections - 1 && (
                  <button
                    onClick={() => goToTab(i + 1)}
                    className="inline-flex items-center gap-1 text-sm font-700 text-primary hover:underline"
                  >
                    {sections[i + 1].section_name} <ChevronRight className="h-4 w-4" />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="mt-6 print-only rounded-xl border border-gold/40 bg-gold-soft/60 p-4">
        <p className="text-xs leading-relaxed text-foreground/80">
          AuditMyIEP is an educational guide to help you advocate for your child. It is NOT legal advice and NOT a substitute for a special-education attorney or advocate.
        </p>
      </div>
    </div>
  );
}
