import { useState, useRef, useEffect, Component } from 'react';
import { loadStripe } from '@stripe/stripe-js';
import { Elements, CardElement, useStripe, useElements } from '@stripe/react-stripe-js';
import { LanguageProvider, useI18n } from '@/lib/i18n';
import AuditReportView from '@/components/audit/AuditReportView';

// Catches any crash anywhere below it and shows the actual error ON the
// page — bright red, plain text — instead of the screen just going blank.
// Nothing here is sent anywhere; it only ever displays in this browser.
// This exists so a real bug shows itself instead of hiding as "nothing."
class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null, info: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    this.setState({ error, info });
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{
          maxWidth: 700, margin: '40px auto', padding: 20,
          fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 13,
          whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          color: '#7a1f1f', background: '#fdeceb',
          border: '2px solid #c33f36', borderRadius: 12,
        }}>
          <h2 style={{ marginTop: 0, fontFamily: 'sans-serif' }}>
            Something crashed — screenshot this whole box and send it to Claude.
          </h2>
          <p><b>{String(this.state.error && this.state.error.message)}</b></p>
          <p>{this.state.error && this.state.error.stack}</p>
          {this.state.info && <p>{this.state.info.componentStack}</p>}
        </div>
      );
    }
    return this.props.children;
  }
}

// Your own local API — set up in backend/app.py. Nothing else in this app
// talks to any other server.
const API_BASE = import.meta.env.VITE_API_BASE || '/api';
const API_URL = `${API_BASE}/audit`;

function formatPrice(cents) {
  const dollars = (cents || 0) / 100;
  return Number.isInteger(dollars) ? `$${dollars}` : `$${dollars.toFixed(2)}`;
}

const AUDIT_STEPS = [
  'Present Levels (PLAAFP)',
  'Consideration of Special Factors',
  'Postsecondary Transition',
  'Annual Goals',
  'Accommodations & Modifications',
  'Extended School Year',
  'State & District Assessments',
  'Service Delivery',
  'Least Restrictive Environment',
  'Progress Reporting',
  'Prior Written Notice',
];

function Logo() {
  return (
    <div className="flex items-center gap-2 text-primary">
      <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-brand">
        <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
          <path d="M12 2l8 4v6c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10V6l8-4z" stroke="currentColor" strokeWidth="1.5" />
          <path d="M9 12l2 2 4-4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
      <span className="font-heading text-lg font-700 text-primary">AuditMyIEP</span>
    </div>
  );
}

function UploadScreen({ onSubmit, errorMsg, paymentsEnabled, amountCents, configLoaded }) {
  const { t } = useI18n();
  const [file, setFile] = useState(null);
  const [fileError, setFileError] = useState('');
  const [consented, setConsented] = useState(false);
  const [email, setEmail] = useState('');
  const emailLooksValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  const inputRef = useRef(null);
  const priceLabel = formatPrice(amountCents);

  // Only accept real PDFs. A phone photo, screenshot, or scanned image
  // (JPG/PNG/HEIC) isn't a PDF — reject it here with a friendly nudge so a
  // parent isn't confused, and so image files never reach the paid audit.
  function acceptFile(f) {
    if (!f) return;
    const isPdf = f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf');
    if (!isPdf) {
      setFile(null);
      setFileError('That looks like an image, not a PDF. Please upload your IEP as a PDF — photos and screenshots (JPG, PNG, HEIC) won’t work. If you only have paper, use your phone’s scan-to-PDF or a free scanner app first.');
      return;
    }
    setFileError('');
    setFile(f);
  }

  return (
    <div className="mx-auto max-w-xl px-4 py-10 sm:py-16">
      <div className="rounded-3xl bg-card border border-border shadow-brand p-6 sm:p-9">
        <Logo />
        <h1 className="mt-6 font-heading text-3xl sm:text-4xl font-800 leading-tight">
          {t('hero.title')}
        </h1>
        <p className="mt-3 text-base leading-relaxed text-foreground/90">
          A section-by-section audit: what's strong, what's vague, and the exact words to ask for instead.
        </p>

        {errorMsg && (
          <div className="mt-5 rounded-xl border border-crit bg-crit-bg p-4 text-sm text-foreground">
            {errorMsg}
          </div>
        )}

        {/* Step 1 label so the flow reads as clear steps. */}
        <div className="mt-6 flex items-center gap-2 text-sm font-800 text-primary">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs">1</span>
          Upload your child's IEP (PDF)
        </div>

        <div
          className={`mt-2 rounded-2xl border-2 p-8 text-center transition-colors ${
            file
              ? 'border-good bg-good-bg'
              : 'border-dashed border-brand/40 bg-brand-soft/50 hover:border-brand/70 hover:bg-brand-soft/70'
          }`}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            if (e.dataTransfer.files[0]) acceptFile(e.dataTransfer.files[0]);
          }}
        >
          <input
            ref={inputRef}
            type="file"
            accept=".pdf,application/pdf"
            className="hidden"
            onChange={(e) => acceptFile(e.target.files?.[0] || null)}
          />

          {file ? (
            // Clear "it's uploaded" state — big green check, the filename,
            // and the upload button is GONE (replaced by a small "change"
            // link) so a parent can't click upload again by accident.
            <>
              <div className="flex items-center justify-center gap-2 text-good">
                <svg viewBox="0 0 24 24" fill="none" className="h-7 w-7">
                  <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" />
                  <path d="M8 12.5l2.5 2.5L16 9.5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <span className="text-lg font-800">PDF uploaded</span>
              </div>
              <p className="mt-2 text-sm font-700 text-foreground break-all">{file.name}</p>
              <button
                type="button"
                onClick={() => inputRef.current?.click()}
                className="mt-3 text-xs font-700 text-primary underline hover:opacity-80"
              >
                Choose a different file
              </button>
            </>
          ) : (
            <>
              <p className="text-sm font-600 text-foreground/80">Drag your IEP PDF here, or</p>
              <button
                type="button"
                onClick={() => inputRef.current?.click()}
                className="mt-3 inline-flex items-center rounded-xl bg-primary px-6 py-3 text-base font-800 text-primary-foreground shadow-brand hover:opacity-90 hover:scale-[1.02] transition-all"
              >
                {t('audit.upload')}
              </button>
              <p className="mt-3 text-xs text-muted-foreground">PDF only — not a photo or screenshot</p>
            </>
          )}
        </div>

        {/* How-to note — only shown until a valid PDF is in, to keep the
            success state clean. */}
        {!file && (
          <div className="mt-3 rounded-xl border border-brand/20 bg-brand-soft/40 p-3 text-xs leading-relaxed text-foreground/80">
            <span className="font-700 text-foreground">Need a PDF?</span> Your IEP must be a PDF file. If yours is a Word doc, a photo, or on paper:
            <span className="block mt-1">• <b>Word doc:</b> open it, then File → Save As (or Export) → PDF.</span>
            <span className="block">• <b>Photo or paper:</b> on your phone, open the Files app (or a free scanner app) and choose “Scan” or “Create PDF,” then upload that.</span>
          </div>
        )}

        {fileError && (
          <div className="mt-3 rounded-xl border border-crit bg-crit-bg p-3 text-sm leading-relaxed text-foreground">
            {fileError}
          </div>
        )}

        {/* Privacy promise — pulled out of the fine print because it's the
            whole reason to trust this tool. Green = safe. */}
        <div className="mt-5 flex items-start gap-3 rounded-2xl border border-good/30 bg-good-bg p-4">
          <svg viewBox="0 0 24 24" fill="none" className="mt-0.5 h-5 w-5 flex-shrink-0 text-good">
            <rect x="4" y="10" width="16" height="10" rx="2" stroke="currentColor" strokeWidth="1.8" />
            <path d="M8 10V7a4 4 0 0 1 8 0v3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
          <p className="text-sm font-500 leading-relaxed text-foreground/90">{t('audit.privacy')}</p>
        </div>

        {/* Step 2 — email, in a bright gold box so nobody scrolls past it. */}
        <div className="mt-5 rounded-2xl border-2 border-gold bg-gold-soft/60 p-4 sm:p-5">
          <div className="flex items-center gap-2 text-sm font-800 text-foreground">
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-gold text-primary text-xs">2</span>
            Where should we email your report?
          </div>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            className="mt-3 w-full rounded-xl border-2 border-border bg-card px-4 py-3 text-base font-500 text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring"
          />
          <p className="mt-2 text-xs font-600 text-foreground/70">
            Your report is sent here automatically as a PDF the moment it's ready — don't skip this.
          </p>
        </div>

        <label className="mt-4 flex items-start gap-3 rounded-xl bg-muted/40 p-3 text-xs leading-relaxed text-foreground/80">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4 flex-shrink-0"
            checked={consented}
            onChange={(e) => setConsented(e.target.checked)}
          />
          <span>{t('audit.consent')}</span>
        </label>

        <button
          type="button"
          disabled={!file || !consented || !emailLooksValid || !configLoaded}
          onClick={() => onSubmit(file, email)}
          className="mt-5 w-full rounded-xl bg-gold px-5 py-3.5 text-base font-800 font-heading text-primary shadow-brand hover:opacity-90 hover:scale-[1.01] transition-all disabled:bg-muted disabled:text-muted-foreground disabled:shadow-none disabled:cursor-not-allowed disabled:hover:scale-100"
        >
          {paymentsEnabled ? `Continue to payment — ${priceLabel}` : t('audit.run')}
        </button>

        <p className="mt-3 text-center text-xs leading-relaxed text-muted-foreground">
          {paymentsEnabled
            ? `One-time ${priceLabel}. Your scored report shows on screen right after payment — usually under a minute — with the full breakdown emailed to you as a PDF.`
            : 'Your scored report shows on screen first — usually under a minute — with the full breakdown emailed to you as a PDF.'}
        </p>
      </div>
    </div>
  );
}

// Its own full screen — not a spinner glued to a button. Cycles through the
// IEP sections Claude is working through so the screen visibly moves,
// instead of sitting still while a parent wonders if anything is happening.
// The cycling is a steady best-guess pace, not a live progress feed from
// the backend (a single API call doesn't expose that) — but real work is
// genuinely happening the whole time it's showing.
function AuditingScreen({ fileName }) {
  const [stepIndex, setStepIndex] = useState(0);

  useEffect(() => {
    const id = setInterval(() => {
      setStepIndex((i) => (i + 1) % AUDIT_STEPS.length);
    }, 3200);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="mx-auto max-w-xl px-4 py-10 sm:py-16">
      <div className="rounded-3xl bg-card border border-border shadow-brand p-6 sm:p-9 text-center">
        <Logo />
        <div className="mt-8 flex justify-center">
          <div className="h-14 w-14 rounded-full border-4 border-brand-soft border-t-primary animate-spin" />
        </div>
        <h1 className="mt-6 font-heading text-2xl sm:text-3xl font-800">Auditing your IEP…</h1>
        <p className="mt-2 text-sm text-muted-foreground break-all">{fileName}</p>

        <div className="mt-5 rounded-2xl border-2 border-crit/40 bg-crit-bg/60 p-4 sm:p-5">
          <p className="font-heading text-xl sm:text-2xl font-800 leading-snug text-crit">
            ⚠ Do NOT close this screen.
          </p>
          <p className="mt-3 font-heading text-lg sm:text-xl font-700 leading-snug text-foreground">
            This can take several minutes depending on the size of your file.
          </p>
          <p className="mt-3 text-base sm:text-lg font-600 leading-relaxed text-foreground/85">
            Thank you for being patient while the system audits your child's IEP. Leaving this page now means starting over.
          </p>
        </div>
        <div className="mt-7 rounded-2xl bg-brand-soft/60 p-4 text-left">
          <div className="text-xs font-700 uppercase tracking-wide text-primary">Checking against federal IDEA &amp; Endrew F.</div>
          <ul className="mt-3 space-y-2">
            {AUDIT_STEPS.map((step, i) => (
              <li
                key={step}
                className={`text-sm ${i === stepIndex ? 'audit-step-active font-700 text-primary' : 'text-foreground/50'}`}
              >
                {step}
              </li>
            )).slice(Math.max(0, stepIndex - 1), stepIndex + 3)}
          </ul>
        </div>
      </div>
    </div>
  );
}

// The card form — Stripe's classic CardElement (a single secure card field:
// number, expiry, CVC, ZIP). It NEVER shows Link, wallets, or a "code" step,
// so nothing can hijack the checkout. This code never sees the card number.
function CheckoutForm({ clientSecret, amountCents, fileName, onPaid, onBack }) {
  const stripe = useStripe();
  const elements = useElements();
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState('');
  const priceLabel = formatPrice(amountCents);

  async function handlePay(e) {
    e.preventDefault();
    if (!stripe || !elements || submitting) return;
    setSubmitting(true);
    setErr('');
    try {
      const card = elements.getElement(CardElement);
      // confirmCardPayment with the raw card element = card-only, on this
      // page, no redirect, no Link, no wallet prompts.
      const { error, paymentIntent } = await stripe.confirmCardPayment(clientSecret, {
        payment_method: { card },
      });
      if (error) {
        setErr(error.message || 'That payment didn’t go through. Please check the card and try again.');
        setSubmitting(false);
        return;
      }
      // 'requires_capture' = card authorized/held (our no-charge-until-report
      // flow); 'succeeded' = already captured. Either means we can proceed to
      // the audit, which is what actually triggers the charge on success.
      if (paymentIntent && (paymentIntent.status === 'requires_capture' || paymentIntent.status === 'succeeded')) {
        onPaid(paymentIntent.id);
      } else {
        setErr('The payment didn’t complete. Please try again.');
        setSubmitting(false);
      }
    } catch (ex) {
      setErr('Something went wrong talking to Stripe. Please try again.');
      setSubmitting(false);
    }
  }

  const cardStyle = {
    style: {
      base: {
        fontSize: '16px',
        color: '#16261f',
        '::placeholder': { color: '#9aa5a0' },
      },
      invalid: { color: '#a1352a' },
    },
  };

  const canPay = Boolean(stripe && elements && !submitting);

  return (
    <form onSubmit={handlePay}>
      <div className="rounded-2xl border border-border bg-muted/30 p-4">
        <div className="flex items-center justify-between text-sm">
          <span className="font-600 text-foreground">IEP audit</span>
          <span className="font-800 text-foreground tnum">{priceLabel}</span>
        </div>
        {fileName && <p className="mt-1 text-xs text-muted-foreground break-all">{fileName}</p>}
      </div>

      <div className="mt-4">
        <label className="mb-1.5 block text-sm font-700 text-foreground">Card details</label>
        <div className="rounded-xl border-2 border-border bg-card px-4 py-3.5">
          <CardElement options={cardStyle} />
        </div>
        <p className="mt-2 text-xs text-muted-foreground">Test card: 4242 4242 4242 4242 · any future date · any CVC · any ZIP</p>
      </div>

      {err && (
        <div className="mt-4 rounded-xl border border-crit bg-crit-bg p-3 text-sm text-foreground">{err}</div>
      )}

      <button
        type="submit"
        disabled={!canPay}
        className="mt-5 w-full rounded-xl bg-gold px-5 py-3.5 text-base font-800 font-heading text-primary shadow-brand hover:opacity-90 hover:scale-[1.01] transition-all disabled:bg-muted disabled:text-muted-foreground disabled:shadow-none disabled:cursor-not-allowed disabled:hover:scale-100"
      >
        {submitting ? 'Processing…' : `Pay ${priceLabel} & run my audit`}
      </button>

      <button
        type="button"
        onClick={onBack}
        disabled={submitting}
        className="mt-3 w-full text-center text-sm font-700 text-primary hover:underline disabled:opacity-50"
      >
        ← Back
      </button>

      <p className="mt-4 text-center text-xs leading-relaxed text-muted-foreground">
        Secure payment by Stripe. Your card details go straight to Stripe — this site never sees them.
      </p>
    </form>
  );
}

function PaymentScreen({ stripePromise, clientSecret, amountCents, fileName, onPaid, onBack }) {
  // No clientSecret in the Elements options — that's what keeps this in
  // classic CardElement mode (card-only). The clientSecret is used directly
  // at confirmCardPayment time inside CheckoutForm.
  return (
    <div className="mx-auto max-w-xl px-4 py-10 sm:py-16">
      <div className="rounded-3xl bg-card border border-border shadow-brand p-6 sm:p-9">
        <Logo />
        <h1 className="mt-6 font-heading text-2xl sm:text-3xl font-800 leading-tight">
          Almost there — one-time {formatPrice(amountCents)}
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-foreground/80">
          Pay below and your audit runs immediately on the next screen. You stay right here — no need to upload anything again.
        </p>
        <div className="mt-6">
          {clientSecret && (
            <Elements stripe={stripePromise}>
              <CheckoutForm
                clientSecret={clientSecret}
                amountCents={amountCents}
                fileName={fileName}
                onPaid={onPaid}
                onBack={onBack}
              />
            </Elements>
          )}
        </div>
      </div>
    </div>
  );
}

function AppInner() {
  // phase: 'upload' | 'payment' | 'auditing' | 'report'
  const [phase, setPhase] = useState('upload');
  const [errorMsg, setErrorMsg] = useState('');
  const [report, setReport] = useState(null);
  const [iepFile, setIepFile] = useState(null);
  const [parentEmail, setParentEmail] = useState('');

  // Stripe config, fetched from the backend on load. Until it arrives we
  // don't let anyone submit (so nobody slips through before we know whether
  // payment is required).
  const [stripeCfg, setStripeCfg] = useState(null); // { enabled, publishable_key, amount_cents }
  const [stripePromise, setStripePromise] = useState(null);
  const [clientSecret, setClientSecret] = useState('');
  const [paymentIntentId, setPaymentIntentId] = useState('');

  useEffect(() => {
    fetch(`${API_BASE}/stripe-config`)
      .then((r) => r.json())
      .then((cfg) => {
        setStripeCfg(cfg);
        if (cfg.enabled && cfg.publishable_key) {
          setStripePromise(loadStripe(cfg.publishable_key));
        }
      })
      .catch(() => setStripeCfg({ enabled: false, amount_cents: 0 }));
  }, []);

  const paymentsEnabled = Boolean(stripeCfg?.enabled);
  const amountCents = stripeCfg?.amount_cents || 0;

  // Called from the upload screen. In free mode it runs the audit straight
  // away; in paid mode it opens a PaymentIntent and moves to the card form.
  async function handleUploadSubmit(file, email) {
    setErrorMsg('');
    setIepFile(file);
    setParentEmail(email || '');

    if (!paymentsEnabled) {
      runAudit(file, email, '');
      return;
    }

    try {
      const res = await fetch(`${API_BASE}/create-payment-intent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErrorMsg(data.error || 'Could not start the payment.');
        return;
      }
      setClientSecret(data.client_secret);
      setPaymentIntentId(data.payment_intent_id);
      setPhase('payment');
    } catch (err) {
      setErrorMsg('Could not reach the payment server. Is app.py running?');
    }
  }

  async function runAudit(file, email, piId) {
    setErrorMsg('');
    setPhase('auditing');
    try {
      const formData = new FormData();
      formData.append('iep_pdf', file);
      if (piId) formData.append('payment_intent_id', piId);
      const res = await fetch(API_URL, { method: 'POST', body: formData });
      const data = await res.json();
      if (!res.ok) {
        setErrorMsg(data.error || 'Something went wrong.');
        setPhase(piId ? 'audit_error' : 'upload');
        return;
      }
      setReport(data.report);
      setPhase('report');
    } catch (err) {
      setErrorMsg('Could not reach the audit server. Is app.py running?');
      setPhase(piId ? 'audit_error' : 'upload');
    }
  }

  function reset() {
    setReport(null);
    setIepFile(null);
    setClientSecret('');
    setPaymentIntentId('');
    setPhase('upload');
  }

  if (phase === 'payment') {
    return (
      <PaymentScreen
        stripePromise={stripePromise}
        clientSecret={clientSecret}
        amountCents={amountCents}
        fileName={iepFile?.name}
        onPaid={(piId) => runAudit(iepFile, parentEmail, piId)}
        onBack={() => setPhase('upload')}
      />
    );
  }

  if (phase === 'audit_error') {
    return (
      <div className="mx-auto max-w-xl px-4 py-10 sm:py-16">
        <div className="rounded-3xl bg-card border border-border shadow-brand p-6 sm:p-9">
          <Logo />
          <h1 className="mt-6 font-heading text-2xl sm:text-3xl font-800">The audit hit a snag</h1>
          <p className="mt-2 text-sm leading-relaxed text-foreground/80">
            Your payment went through and you will <b>not</b> be charged again. Here's exactly what happened:
          </p>
          <div className="mt-4 rounded-xl border border-crit bg-crit-bg p-4 text-sm leading-relaxed text-foreground break-words">
            {errorMsg || 'Unknown error.'}
          </div>
          <button
            type="button"
            onClick={() => runAudit(iepFile, parentEmail, paymentIntentId)}
            className="mt-5 w-full rounded-xl bg-gold px-5 py-3.5 text-base font-800 font-heading text-primary shadow-brand hover:opacity-90 transition-all"
          >
            Try the audit again — no new charge
          </button>
          <button
            type="button"
            onClick={() => { setErrorMsg(''); setPhase('upload'); }}
            className="mt-3 w-full text-center text-sm font-700 text-primary hover:underline"
          >
            ← Start over
          </button>
        </div>
      </div>
    );
  }

  if (phase === 'auditing') {
    return <AuditingScreen fileName={iepFile?.name} />;
  }

  if (phase === 'report' && report) {
    return (
      <div className="mx-auto max-w-6xl px-4 py-8">
        <AuditReportView
          report={report}
          iepFile={iepFile}
          initialEmail={parentEmail}
          title="Your IEP Audit Report"
          meta="Audited against federal IDEA (34 CFR Part 300) and the Endrew F. standard"
        />
        <button
          type="button"
          onClick={reset}
          className="no-print mt-6 text-sm font-700 text-primary hover:underline"
        >
          ← Audit another IEP
        </button>
      </div>
    );
  }

  return (
    <UploadScreen
      onSubmit={handleUploadSubmit}
      errorMsg={errorMsg}
      paymentsEnabled={paymentsEnabled}
      amountCents={amountCents}
      configLoaded={stripeCfg !== null}
    />
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <LanguageProvider>
        <AppInner />
      </LanguageProvider>
    </ErrorBoundary>
  );
}
