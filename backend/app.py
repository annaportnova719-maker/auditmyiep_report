"""
AuditMyIEP — Audit API (v2)
---------------------------
A small JSON API that powers the real AuditMyIEP React app. It talks to
Claude in TWO passes instead of one big one:

  1. Overview pass (/api/audit) — fast. Scores every section and gives the
     headline finding + one advocacy line for each. This is what shows up
     first, right after you click "Run audit."
  2. Section-detail pass (/api/section-detail) — only runs for ONE section,
     only when a parent clicks "Understand it & how to advocate" on that
     specific section. That's where the deep plain-language explanation,
     the three-question script, and the model IEP language get written.

Splitting it this way is what makes the app fast: nobody reads the deep
advocacy content for all 11 sections at once, so there's no reason to
generate it for all 11 before showing anything.

There's also a third, much smaller endpoint (/api/email-report) that emails
a parent a copy of the report they already have on screen, and — only if
they check a separate "keep me updated" box — saves their email address to
a local list for your own marketing. See the EMAIL section below for the
exact, narrow privacy boundary around that.

PRIVACY, BY DESIGN:
  - The uploaded PDF is held ONLY in memory for the length of each single
    request (both the overview call and every section-detail call). It is
    never written to disk, never logged, and never stored in a database.
  - Nothing about a specific family's IEP is retrievable after a request
    finishes — not by a parent coming back later, and not by you.
  - This app calls Claude directly, under Anthropic's standard commercial
    API terms (not used to train models by default) — no Base44, no
    Gemini, no other AI vendor in the loop.

Read the comments as you go — they explain the "why," not just the "what."
"""

import os
import re
import csv
import base64
import smtplib
from io import BytesIO
from datetime import datetime, timezone
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.mime.application import MIMEApplication

import threading
import uuid as _uuid_mod
from flask import Flask, request, jsonify, Response, send_from_directory
from flask_cors import CORS
from dotenv import load_dotenv
import anthropic
import stripe

from reportlab.lib.pagesizes import LETTER
from reportlab.lib.units import inch
from reportlab.lib import colors
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.enums import TA_LEFT
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle,
    KeepTogether, PageBreak, ListFlowable, ListItem,
)
from reportlab.graphics.shapes import Drawing, Rect

load_dotenv()

app = Flask(__name__)
CORS(app)  # allows the React dev server (a different port) to call this API

MAX_FILE_BYTES = 25 * 1024 * 1024  # reject oversized uploads before they cost tokens
MAX_PDF_PAGES = 60  # a normal IEP is ~10–30 pages; this blocks giant packets
CLAUDE_MODEL = os.environ.get("CLAUDE_MODEL", "claude-opus-4-8")

# Optional: used only to count pages for the cost guard. If it isn't
# installed, the page check is skipped (everything else still works).
try:
    from pypdf import PdfReader
except Exception:
    try:
        from PyPDF2 import PdfReader
    except Exception:
        PdfReader = None

client = anthropic.Anthropic()  # reads ANTHROPIC_API_KEY from the environment

# ---------------------------------------------------------------------------
# BACKGROUND JOB STORE — lets the audit run in a background thread so the
# HTTP request returns immediately (no gunicorn timeout, no matter how big
# the IEP is). The frontend polls /api/audit-status/<job_id> every few
# seconds until the result is ready.
# ---------------------------------------------------------------------------
_jobs: dict = {}
_jobs_lock = threading.Lock()

def _run_audit_job(job_id: str, pdf_bytes: bytes, payment_intent_id: str, email: str = "") -> None:
    """Runs in a daemon thread. Stores result in _jobs[job_id]."""
    try:
        report = run_overview_audit(pdf_bytes)

        # Capture payment now that the audit succeeded
        if PAYMENTS_ENABLED and payment_intent_id:
            try:
                intent = stripe.PaymentIntent.retrieve(payment_intent_id)
                if getattr(intent, "status", None) == "requires_capture":
                    stripe.PaymentIntent.capture(payment_intent_id)
            except Exception as e:
                print(f"[capture warning] could not capture {payment_intent_id}: {e}")
            try:
                _mark_payment_used(payment_intent_id)
            except OSError:
                pass

        # Save the purchaser's email to the marketing list. A completed
        # purchase creates a business relationship, so this is permitted
        # under CAN-SPAM; marketing emails still carry an unsubscribe link.
        if email and EMAIL_RE.match(email):
            try:
                append_marketing_email(email)
            except OSError:
                pass  # never fail a paid audit over the mailing list

        with _jobs_lock:
            _jobs[job_id] = {"status": "done", "report": report}
    except Exception as e:
        with _jobs_lock:
            _jobs[job_id] = {"status": "error", "error": str(e)}

# --------------------------------------------------------------------------
# PAYMENT (Stripe) — a parent pays once, and that single payment unlocks
# exactly one audit. The card form lives right on the page (Stripe's secure
# Payment Element), so nobody ever leaves the site and nobody re-uploads.
#
# HOW THE GATE WORKS:
#   1. The page asks this server to create a PaymentIntent for the set price.
#   2. Stripe collects the card in the browser and confirms the payment.
#   3. The page then runs the audit, handing back the payment's id.
#   4. This server checks with Stripe that the payment truly succeeded AND
#      that this payment hasn't already been used for an audit — then runs
#      it and records the id as spent, so the same payment can't be reused.
#
# WHAT'S STORED: only Stripe payment ids (in used_payments.csv) — never an
# IEP, never report content, never a card number (Stripe handles all card
# data; this server never sees it). This is payment bookkeeping, not the
# child's data, so it doesn't touch the no-storage promise for IEPs.
#
# If STRIPE_SECRET_KEY isn't set, the app runs in FREE mode — no payment
# step at all — so you can still test the audit itself without Stripe.
# --------------------------------------------------------------------------

STRIPE_SECRET_KEY = os.environ.get("STRIPE_SECRET_KEY")
STRIPE_PUBLISHABLE_KEY = os.environ.get("STRIPE_PUBLISHABLE_KEY")
AUDIT_PRICE_CENTS = int(os.environ.get("AUDIT_PRICE_CENTS", "1900"))  # $19.00
PAYMENTS_ENABLED = bool(STRIPE_SECRET_KEY and STRIPE_PUBLISHABLE_KEY)
USED_PAYMENTS_PATH = os.path.join(os.path.dirname(__file__), "used_payments.csv")

if STRIPE_SECRET_KEY:
    stripe.api_key = STRIPE_SECRET_KEY


def _payment_already_used(payment_intent_id: str) -> bool:
    if not os.path.exists(USED_PAYMENTS_PATH):
        return False
    with open(USED_PAYMENTS_PATH, newline="") as f:
        for row in csv.reader(f):
            if row and row[0] == payment_intent_id:
                return True
    return False


def _mark_payment_used(payment_intent_id: str) -> None:
    is_new = not os.path.exists(USED_PAYMENTS_PATH)
    with open(USED_PAYMENTS_PATH, "a", newline="") as f:
        writer = csv.writer(f)
        if is_new:
            writer.writerow(["payment_intent_id", "used_at_utc"])
        writer.writerow([payment_intent_id, datetime.now(timezone.utc).isoformat()])


def _verify_paid_or_error(payment_intent_id: str):
    """Returns None if this payment is good to spend on one audit, or an
    (json, status) error tuple if not. In FREE mode (no Stripe keys) this
    always passes."""
    if not PAYMENTS_ENABLED:
        return None
    if not payment_intent_id:
        return (jsonify({"error": "Payment is required before running an audit."}), 402)
    try:
        intent = stripe.PaymentIntent.retrieve(payment_intent_id)
    except Exception:
        return (jsonify({"error": "We couldn't verify that payment. Please try again."}), 402)
    # Stripe objects are NOT plain dicts — use attribute access, not .get().
    # "requires_capture" = card authorized/held (our manual-capture flow),
    # "succeeded" = already captured. Either means a valid, live payment.
    if getattr(intent, "status", None) not in ("requires_capture", "succeeded"):
        return (jsonify({"error": "That payment hasn't gone through yet."}), 402)
    if getattr(intent, "amount", None) != AUDIT_PRICE_CENTS:
        return (jsonify({"error": "That payment amount doesn't match the audit price."}), 402)
    if _payment_already_used(payment_intent_id):
        return (jsonify({"error": "This payment has already been used for an audit."}), 402)
    return None

# --------------------------------------------------------------------------
# EMAIL — sends a parent their own report copy, and, only if they check the
# separate "keep me updated" box, saves their email address to a local list
# for your own future marketing. This is the ONE thing this app stores on
# purpose. It is NOT an exception to the no-storage rule for IEPs — no IEP
# content, no report content, and no name ever goes in this file. Just an
# email address and the date, and only when the parent opts in for it.
# --------------------------------------------------------------------------

ZOHO_EMAIL = os.environ.get("ZOHO_EMAIL")  # e.g. help@auditmyiep.com
ZOHO_APP_PASSWORD = os.environ.get("ZOHO_APP_PASSWORD")

# Resend — HTTP-based email (works on Railway; SMTP ports are blocked there).
RESEND_API_KEY = os.environ.get("RESEND_API_KEY")
# Until auditmyiep.com is verified in Resend, sends come from Resend's shared
# test domain. Once the domain is verified, set RESEND_FROM to a
# help@auditmyiep.com address in Railway and it takes over automatically.
RESEND_FROM = os.environ.get("RESEND_FROM", "AuditMyIEP <onboarding@resend.dev>")
MARKETING_LIST_PATH = os.path.join(os.path.dirname(__file__), "marketing_emails.csv")

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


# --------------------------------------------------------------------------
# THE RUBRIC — ported directly from your Base44 build's shared/audit.ts,
# translated to Anthropic's request format. Same standard, same fields,
# same scoring guide — just pointed at Claude instead of Base44's AI
# wrapper (which was calling Google Gemini). Shared between both passes.
# --------------------------------------------------------------------------

COLORADO_STANDARDS = "\n\n=== COLORADO GROUNDING \u2014 authoritative reference for this audit; apply and CITE it ===\nThis product audits COLORADO IEPs. You are grounded in these sources and must apply and cite them: the federal IDEA (34 C.F.R. Part 300) as the floor; Colorado's Exceptional Children's Educational Act (ECEA) rules; the CDE IEP Procedural Guidance; and Endrew F. v. Douglas County Sch. Dist. (2017) \u2014 a COLORADO case \u2014 requiring an IEP \"reasonably calculated to enable a child to make progress appropriate in light of the child's circumstances.\" Do NOT say \"check your state\" for Colorado \u2014 you have Colorado's rules below. If the uploaded IEP is clearly from another state, say the Colorado-specific timelines/ECEA cites may not apply, but keep the IDEA analysis.\n\nTHE ACCOUNTABILITY TEST \u2014 apply to every line: If the school did nothing, could the parent open this IEP, point to ONE specific sentence, and prove the promise was broken? If no, the language is unenforceable \u2014 flag it and give specific replacement wording. Specificity protects three things: (1) failure to implement \u2014 specific minutes/settings prove a service wasn't delivered, \"as available\" can't be violated; (2) lack of progress \u2014 a measurable goal with a baseline proves the school fell short, an unmeasurable goal never can; (3) the record \u2014 PWN captures what was proposed/refused and why.\n\nCOLORADO TIMELINES to check and cite: evaluation completed within 60 days of signed consent (written extension only for a specific learning disability); initial IEP within 90 calendar days of consent to evaluate; annual review within 365 days of the last IEP; reevaluation at least every 3 years unless waived in writing; Notice of Meeting early enough to attend (10 days commonly accepted), listing attendees by role.\n\nCOLORADO IEP SECTIONS \u2014 in form order, with the legal anchor to cite and the red flags to catch:\n1. Student & Family Info \u2014 34 C.F.R. 300.30, 300.503(c). Red flags: wrong educational decision-maker listed; home language noted but no interpreter offered.\n2. Parent & Student Input \u2014 34 C.F.R. 300.322(a), 300.324(a)(1)(ii); CDE Procedural Guidance Appendix D. Red flags: blank or reduced to \"parent is supportive\"; concerns the parent raised not reflected anywhere.\n3. Present Levels (PLAAFP) \u2014 34 C.F.R. 300.320(a)(1). Strong = current, multi-source baselines with numbers (e.g., \"reads 62 wcpm; benchmark 100\") plus a plain statement of how the disability affects access to the general curriculum. Red flags: no baseline data (\"struggles with reading\"); last year's present levels copied forward; a need named here that no goal/service addresses (golden-thread break); only scores with no instructional meaning.\n4. Consideration of Special Factors \u2014 34 C.F.R. 300.324(a)(2). Must consider behavior (positive behavioral interventions, not just discipline), assistive technology, and communication/language needs. Red flags: every box checked \"no\" without discussion; known behavior/AT need not reflected; AT skipped.\n5. Postsecondary Transition \u2014 COLORADO: begins with the first IEP when the child is 15, or no later than the end of 9th grade (earlier than the federal age 16). ECEA 4.03(6)(d)(i); 34 C.F.R. 300.320(b). Strong = measurable post-school goals based on age-appropriate transition assessment, a multi-year course of study, specific transition services, and at least one annual goal linked to each post-school goal; student invited. Red flags: generic goals (\"student will explore careers\") with no assessment; student not invited or interests not reflected; no linkage between annual and post-school goals.\n6. Annual Goals & Objectives \u2014 34 C.F.R. 300.320(a)(2). Strong = SMART with a stated baseline, target, condition, and measurement method (e.g., \"given X, will do Y at Z% across 3 data points by [date]\"); one goal per identified need; short-term objectives/benchmarks are required for students on alternate standards. Red flags: \"will improve reading\" with no baseline/number/method; goals copied from last year with only the date changed; more needs in present levels than there are goals; no way to tell from the goal whether it was met.\n7. Accommodations & Modifications \u2014 34 C.F.R. 300.320(a)(4),(6). Accommodations change HOW the child accesses learning (access); modifications change WHAT is learned (content). Strong = specific accommodations naming who provides them, where, and how often; any 1:1 or intrusive support paired with a fading plan; supports for staff. Red flags: a generic menu not tied to the child's needs; accommodations listed but not delivered; a modification's diploma-track impact not documented.\n8. Extended School Year (ESY) \u2014 34 C.F.R. 300.106. Must be considered individually for EVERY student, decided on regression, recoupment, and/or predictive factors, and documented; cannot be denied because the district has no program, or by disability category. Red flags: ESY dismissed in one sentence with no data; a categorical denial (\"we don't do ESY for this\").\n9. State & District Assessments \u2014 34 C.F.R. 300.320(a)(6). Testing accommodations should match the child's daily instructional accommodations and be allowable on the test; an alternate assessment is only for the most significant cognitive disabilities and the impact must be explained. Red flags: instructional accommodations silently not carried over to testing; alternate assessment proposed without discussing long-term impact.\n10. Service Delivery Statement \u2014 34 C.F.R. 300.320(a)(7). Must state service, minutes, frequency, provider role, setting (inside vs. outside general education), and start/end dates, so anyone can tell exactly what is promised. Red flags: \"as needed\"/\"consult\" with no minutes; minutes reduced with no data-based reason; goals that clearly require more instruction than the minutes allow.\n11. LRE & Placement \u2014 34 C.F.R. 300.114 through 300.116. General education with supplementary aids and services must be considered FIRST; removal is allowed only when needs can't be met there even with supports and must be justified in writing; placement is decided by the team AFTER goals and services, not before. Red flags: placement decided before goals/services (backward); removal justified by disability category or staffing convenience; \"this is the only program we have.\"\n12. Progress Reporting \u2014 34 C.F.R. 300.320(a)(3). Must state when periodic progress reports are provided (commonly quarterly), reported against each goal's measurable target with data; stalled progress is a trigger to reconvene and revise. Red flags: \"progressing\" with no data attached; no progress reports sent between annual meetings.\n13. Prior Written Notice (PWN) \u2014 34 C.F.R. 300.503. Before the school proposes or refuses a change to identification, evaluation, placement, or FAPE, it must explain what, why, the data relied on, and the options considered and rejected. Red flags: a PWN that just says \"IEP was reviewed\"; a refusal with no supporting data; a PWN that doesn't match what was discussed.\n\nVAGUE-LANGUAGE DECODER \u2014 when you see the wording on the left, name why it can't be enforced and give the fix on the right:\n- \"support as needed / as appropriate\" -> service, minutes, frequency, provider, setting (e.g., \"30 min, 3x/week, small group, by a special educator, in the resource room\").\n- \"access to [aide/AT/service]\" -> state the child will USE it, when, and who ensures it (\"uses text-to-speech for all reading tasks over one paragraph; teacher ensures it is available daily\").\n- \"consultation/collaboration\" with no minutes -> put time on it (\"20 min/week of special-ed consultation to the general-ed teacher\").\n- \"provided by qualified staff\" -> name the provider role + minutes + frequency + setting.\n- \"will improve [skill]\" -> baseline + target + condition + measurement method + date.\n- \"progressing / making progress\" -> report against the goal's baseline and target with actual data each reporting period.\n- \"will be exposed to grade-level content\" -> name the accommodation/modification that provides access and how mastery is measured.\n- \"preferential seating\" -> \"seated within 6 feet of instruction, away from the doorway and high-traffic areas.\"\n- \"extra time\" -> \"1.5x time on all tests and in-class writing tasks.\"\n- \"breaks as needed\" -> \"may request a 5-minute movement break up to 3x/period; staff honor it without penalty.\"\n- \"check for understanding\" -> \"teacher has the student restate directions at the start of each assignment.\"\n- \"general education with support\" -> list the specific supplementary aids and services that make general education work.\n- \"included when appropriate\" -> specify the settings and times, the supports provided, and require written justification for any removal.\n- \"small-group setting\" -> state the group size/ratio, the provider, and the subject and time.\n- \"will be redirected\" -> reference the Behavior Intervention Plan; name the specific strategy and who carries it out.\n- \"positive reinforcement\" -> name the reinforcement system, the schedule, and who delivers it.\n\nIn the legal_basis/citation fields, cite the specific anchor above (ECEA rule, CFR section, or \"CDE Procedural Guidance (<section>)\"), and prefer the Colorado-specific rule when one exists \u2014 especially transition at age 15 under ECEA 4.03(6)(d).\n"


STANDARDS_INSTRUCTIONS = """You are an IEP audit engine for U.S. parents. You will be given the full text (and/or pages) of a child's Individualized Education Program (IEP). Analyze it against the federal IDEA (34 C.F.R. Part 300) and the Endrew F. v. Douglas County School District standard — which requires an IEP to be "reasonably calculated to enable a child to make progress appropriate in light of the child's circumstances." Apply federal IDEA as the nationwide floor; some timelines vary by state (e.g., transition planning starts at 16 federally but earlier in some states, such as 15 in Colorado) — where a requirement is state-specific and you don't have that state's rules, say "check your state."

You are producing EDUCATIONAL analysis to help a parent advocate — NOT legal advice, and never a prediction of any legal outcome. Never fabricate; if the IEP omits something, say it appears missing. Cite the page number from the document where you can.

Analyze the full Colorado IEP, IN THIS ORDER, returning one section entry for each: (1) Student & Family Information, (2) Parent & Student Input, (3) Present Levels of Academic Achievement & Functional Performance (PLAAFP), (4) Consideration of Special Factors (incl. assistive technology), (5) Postsecondary Transition Plan, (6) Annual Goals & Objectives, (7) Accommodations & Modifications, (8) Extended School Year (ESY), (9) State & District Assessments, (10) Service Delivery Statement, (11) Least Restrictive Environment (LRE) & Placement, (12) Progress Reporting, and (13) Prior Written Notice. Cover every one of these sections so the report never silently skips part of the IEP. If a required section is absent from the uploaded document, STILL include it as its own entry with grade 'Missing' and say plainly that it appears to be missing — a missing section is a finding the parent needs, not a section to drop. Only merge or rename a section if the IEP itself clearly combines them.

For EACH section, judge two things: (1) COMPLIANCE — does it meet the legal bar (baselines, measurable goals, required elements)? (2) ENFORCEABILITY — if the school did nothing, could the parent point to specific words and prove a promise was broken? Vague language ("as needed," "access to," "when the student requests," "as available," "consult" with no minutes) is the enemy of enforceability — flag it. Apply the golden thread: every need named in Present Levels must be answered by a goal, accommodation, or service; flag any need with nothing attached.

Scoring: baseline + measurable + specific + enforceable = 80-100; missing baselines or vague frequency = 45-70; "as needed"/self-advocacy-conditioned/no-minutes/named-need-with-no-goal = 0-40. Overall = balanced average weighted toward Goals, Accommodations, Services, and Prior Written Notice. The compliance_score reflects COMPLIANCE across sections; the enforceability_score reflects ENFORCEABILITY across sections.

Tone: warm, plain-language first, citations in support; never minimize the child's needs; frame strengths as the reason to provide support, never to reduce it.

Write EVERY piece of output text in clear, warm, plain-language English suitable for a non-expert U.S. parent. Use the parent's perspective ('your child'). Keep all legal citations in their original form (e.g. 34 CFR §300.320).""" + COLORADO_STANDARDS


OVERVIEW_INSTRUCTIONS = STANDARDS_INSTRUCTIONS + """

For the "if_no_detail_yet" field on any section graded Weak, Needs work, or Missing, give ONE short sentence telling the parent how to get the missing specific WRITTEN INTO the IEP by a date (e.g., ask for a short observation/trial and a data-collection plan with a revisit date, or an interim measurable placeholder with a firm finalize date) — never left open-ended. For Strong sections, use an empty string.

This is the FAST OVERVIEW pass, and SPEED MATTERS: keep every field tight. what_we_found is 1-2 sentences, not a paragraph. your_move is one sentence. legal_basis is one sentence. Do NOT write the deeper plain-language explanation, the falls-short reasoning, the three-question script, or model IEP language here — those are generated separately, one section at a time, only when a parent asks to see them.

For EVERY section, also set compliance_score and enforceability_score (0-100): compliance = does the section contain the legal elements it must; enforceability = from the words alone, could the parent point to a specific sentence and prove a promise was broken. section_score blends the two. A section can be compliant on paper yet weak on enforceability (vague wording) — show that split honestly.

Call the `record_audit_overview` tool exactly once with your complete findings for every section."""


SECTION_INSTRUCTIONS = STANDARDS_INSTRUCTIONS + """

This is a FOLLOW-UP pass for ONE section only. You will be told which section, along with what the fast overview already found for it (its grade, score, and summary). Stay consistent with that overview — do not contradict it. Go deeper: explain it in plain terms, explain specifically why it falls short of the standard (or, if it's Strong, why it holds up), give the three-question advocacy script for the meeting room, name the concrete change to ask for, and write the exact replacement language for the IEP — plus, separately, why that specific target is right for this child, how progress on it will be tracked, and what services back it up.

THE THREE QUESTIONS ARE A LADDER, NOT THREE OPTIONS — each one is a specific, pointed question built to pull real information out of the IEP team, and each step only exists because the previous answer wasn't good enough. ask_start pulls the baseline fact ("what specifically is being done right now, how often, by whom"). ask_if_vague pulls the missing specifics when the first answer is soft ("as needed," "we'll see," "when he needs it") — name exactly what's missing (frequency? a number? who decides?) and ask for that. ask_if_stuck is the accountability question for when the team still won't commit — it should reference what the IEP is legally required to contain, in plain words, so the parent is visibly asking for what the law requires, not just being pushy. All three should read as one escalating conversation aimed at the same target, and that target must be exactly what `what_to_ask_for` asks for — a parent should be able to see, reading top to bottom, exactly how the conversation gets from "what's happening now" to "here is my ask."

why_this_target must do real work, not restate the ask: name the SPECIFIC, documented thing about this child (from the IEP's own present-levels data, goals, or evaluation results) that makes this particular number/frequency/wording the right one — and connect it to the legal standard (cite it) so the ask reads as "this is what THIS child needs, and here is the law that backs it up," never a generic best practice.

FORMATTING RULE — every field is short, plain sentences a tired parent can scan in seconds. Never use markdown syntax anywhere: no **bold**, no bullet dashes, no pipe tables, no ### headers, no horizontal rules. Never fold two ideas into one field just because it allows long text — put each idea only in the field that asks for it. The `model_language` field matters most: it must contain ONLY the clean words the IEP should say, nothing else mixed in, so a parent can select it and paste it straight into an email with zero cleanup.

Call the `record_section_detail` tool exactly once with your findings for this one section only."""


OVERVIEW_TOOL = {
    "name": "record_audit_overview",
    "description": "Record the fast overview of the IEP audit — scores and per-section headline findings, without the deep-dive advocacy content.",
    "input_schema": {
        "type": "object",
        "required": [
            "overall_score", "verdict", "summary", "compliance_score",
            "enforceability_score", "strengths", "weak_points", "sections",
        ],
        "properties": {
            "overall_score": {"type": "number", "description": "0-100 overall IEP strength score"},
            "verdict": {"type": "string", "description": "Short verdict phrase, e.g. 'Enforceable in parts'"},
            "summary": {"type": "string", "description": "2-4 sentence plain-language summary of the IEP"},
            "compliance_score": {"type": "number", "description": "0-100 compliance sub-score"},
            "enforceability_score": {"type": "number", "description": "0-100 enforceability sub-score"},
            "strengths": {"type": "string", "description": "One paragraph naming what is genuinely strong"},
            "weak_points": {
                "type": "array",
                "items": {"type": "string"},
                "description": "The 4-6 weak points that matter most, each one sentence",
            },
            "sections": {
                "type": "array",
                "description": "One entry per IEP section, in document order",
                "items": {
                    "type": "object",
                    "required": [
                        "grade", "section_score", "compliance_score", "enforceability_score",
                        "section_name", "page_number",
                        "what_we_found", "your_move", "legal_basis", "citation",
                        "if_no_detail_yet",
                    ],
                    "properties": {
                        "grade": {"type": "string", "enum": ["Strong", "Needs work", "Weak", "Missing"]},
                        "section_score": {"type": "number", "description": "0-100 overall for this section (blend of compliance + enforceability)"},
                        "compliance_score": {"type": "number", "description": "0-100: does THIS section meet the legal elements it must contain?"},
                        "enforceability_score": {"type": "number", "description": "0-100: from the words alone, could a parent prove a broken promise in THIS section?"},
                        "section_name": {"type": "string", "description": "Full section name from the IEP form"},
                        "page_number": {"type": "string", "description": "Page where the section begins, as a string"},
                        "what_we_found": {"type": "string", "description": "1-2 short sentences of findings. NOT a long paragraph — be concise."},
                        "your_move": {"type": "string", "description": "The single advocacy line the parent should use, in quotes. One sentence."},
                        "legal_basis": {"type": "string", "description": "One short sentence stating the legal requirement."},
                        "citation": {"type": "string", "description": "The CFR / statute citation only, e.g. 34 CFR §300.320(a)(1)"},
                        "if_no_detail_yet": {"type": "string", "description": "ONE short sentence on how to get the missing specific written into the IEP. Empty string for Strong sections."},
                    },
                },
            },
        },
    },
}


SECTION_DETAIL_TOOL = {
    "name": "record_section_detail",
    "description": "Record the deep-dive advocacy content for exactly one IEP section, broken into short, clearly separated pieces — never one long paragraph.",
    "input_schema": {
        "type": "object",
        "required": [
            "in_plain_terms", "why_it_falls_short", "ask_start", "ask_if_vague",
            "ask_if_stuck", "what_to_ask_for", "model_language", "why_this_target",
            "how_progress_is_tracked", "services_that_support_it",
        ],
        "properties": {
            "in_plain_terms": {"type": "string", "description": "2-4 short sentences, plain English, no legal jargon, explaining what this section means for the child. Plain prose only — no markdown symbols (no **, no bullet dashes, no tables)."},
            "why_it_falls_short": {"type": "array", "items": {"type": "string"}, "description": "3 to 5 concise, specific points on why this falls short of the standard (or, for a Strong section, why it holds up). Each item is ONE complete point (a short sentence or two) a parent can read aloud or paste into an email. Plain prose, no markdown, and do NOT add your own numbers or dashes (the app numbers them)."},
            "ask_start": {"type": "string", "description": "Step 1: the warm opening question to ask the team, in quotes, one or two sentences"},
            "ask_if_vague": {"type": "string", "description": "Step 2: the follow-up question if the answer is vague, in quotes, one or two sentences"},
            "ask_if_stuck": {"type": "string", "description": "Step 3: the legal-accountability question if the team won't budge, in quotes, one or two sentences"},
            "what_to_ask_for": {"type": "array", "items": {"type": "string"}, "description": "2 to 4 concise points naming the concrete change(s) to request. Each item is ONE complete point (a short sentence or two) a parent can read aloud in a meeting or paste into an email. Plain prose, no markdown, and do NOT add your own numbers or dashes (the app numbers them)."},
            "model_language": {"type": "array", "items": {"type": "string"}, "description": "The exact replacement language the IEP should contain, broken into 2 to 5 discrete, ready-to-paste statements — each item ONE clean clause or sentence the IEP should say (e.g. one item for the service minutes, one for the frequency, one for who delivers it, one for how progress is measured). A parent will paste these as a numbered list into an email or IEP-amendment request. ONLY the words the IEP should say — no headers, rationale, markdown, or leading numbers/dashes (the app numbers them)."},
            "why_this_target": {"type": "array", "items": {"type": "string"}, "description": "2 to 4 concise points explaining why THIS specific target or number is right for this child, each tied to the data for this child or to the law. Each item is ONE complete point. Plain prose, no markdown, no leading numbers or dashes (the app numbers them)."},
            "how_progress_is_tracked": {"type": "string", "description": "1-3 short sentences on how and how often progress toward this will be measured and reported. Plain prose, no markdown."},
            "services_that_support_it": {
                "type": "array",
                "items": {"type": "string"},
                "description": "0-4 short strings naming the specific service(s)/minutes that back this up (e.g. '200 min/week small-group reading intervention'). Empty array if not applicable to this section.",
            },
        },
    },
}


# --------------------------------------------------------------------------
# WHY WE SEND TEXT, NOT THE PDF ITSELF:
# A real IEP is 30-40 pages. Sending it as a PDF makes Claude read every page
# as an IMAGE — tens of thousands of vision tokens — which is slow (5-7+ min),
# expensive, and on big files unreliable (the answer gets cut off and comes
# back empty). Instead we pull the text out of the PDF once (pypdf, local,
# instant) and send that. It's dramatically faster, far cheaper, and reliable.
# The ONLY case where we fall back to sending the PDF is a scanned/image-only
# IEP that has no extractable text.
# --------------------------------------------------------------------------

IEP_MIN_TEXT_CHARS = 800  # below this we assume a scanned PDF and send the PDF itself


class _RetryableAudit(Exception):
    """An audit result that came back empty/garbled — worth one auto-retry
    before we ever show the parent an error."""


def _iep_text_or_none(pdf_bytes: bytes):
    """Extract the IEP's text so we can send lightweight text instead of
    30+ page-images. Returns None for scanned/image-only PDFs."""
    if PdfReader is None:
        return None
    try:
        reader = PdfReader(BytesIO(pdf_bytes))
        text = "\n\n".join((pg.extract_text() or "") for pg in reader.pages)
    except Exception:
        return None
    return text if len(text.strip()) >= IEP_MIN_TEXT_CHARS else None


def _overview_content(pdf_bytes, iep_text):
    if iep_text:
        return [{"type": "text", "text":
                 "This is a parent's child's IEP (the full text is below). "
                 "Audit it per your instructions.\n\n" + iep_text}]
    pdf_b64 = base64.standard_b64encode(pdf_bytes).decode("utf-8")
    return [
        {"type": "document", "source": {"type": "base64", "media_type": "application/pdf", "data": pdf_b64}},
        {"type": "text", "text": "This is a parent's child's IEP. Audit it per your instructions."},
    ]


def _overview_once(content) -> dict:
    """One attempt at the overview. Raises _RetryableAudit on an empty/garbled
    result so the caller can retry once."""
    with client.messages.stream(
        model=CLAUDE_MODEL,
        max_tokens=16000,
        system=OVERVIEW_INSTRUCTIONS,
        tools=[OVERVIEW_TOOL],
        tool_choice={"type": "tool", "name": "record_audit_overview"},
        messages=[{"role": "user", "content": content}],
    ) as stream:
        message = stream.get_final_message()

    if message.stop_reason == "max_tokens":
        raise _RetryableAudit("The audit got cut off before it finished.")

    for block in message.content:
        if block.type == "tool_use" and block.name == "record_audit_overview":
            result = block.input
            sections = result.get("sections")
            if isinstance(sections, dict):
                try:
                    sections = [sections[k] for k in sorted(sections.keys(), key=lambda k: int(k))]
                    result["sections"] = sections
                except (ValueError, TypeError):
                    raise _RetryableAudit("The section list came back in an unexpected format.")
            if not isinstance(sections, list) or not sections:
                raise _RetryableAudit("The audit came back without any section findings.")
            return result

    raise _RetryableAudit("Claude did not return a structured audit.")


def run_overview_audit(pdf_bytes: bytes) -> dict:
    """Pass 1 — scores + headline findings for every section, from the IEP's
    text. Retries once automatically if the first result is empty. Nothing
    here touches disk."""
    iep_text = _iep_text_or_none(pdf_bytes)
    content = _overview_content(pdf_bytes, iep_text)

    last = None
    for _ in range(2):  # first try + one automatic retry
        try:
            return _overview_once(content)
        except _RetryableAudit as e:
            last = e
    detail = f"{last} " if last else ""
    raise RuntimeError(detail + "The audit didn't complete after a retry. Please try again.")


def run_section_detail(pdf_bytes: bytes, section_context: dict) -> dict:
    """Pass 2 — runs only for one section, only when a parent opens it. Uses
    the IEP's text (same speed/cost win as the overview). Nothing here touches
    disk either."""
    context_text = (
        "The fast overview already found this about the \""
        + section_context.get("section_name", "")
        + "\" section (page " + section_context.get("page_number", "—") + "): grade = "
        + section_context.get("grade", "—") + ". What was found: "
        + section_context.get("what_we_found", "—")
        + " The advocacy move already given: "
        + section_context.get("your_move", "—")
        + " Now go deeper on this ONE section only, per your instructions."
    )

    # Prompt caching: put the stable, reused content FIRST — the full IEP text
    # (identical for every section), which the cache prefix also covers the
    # section system prompt and tools — and mark it ephemeral. The first section
    # in an audit pays the one-time cache write; the other ~12 sections read the
    # IEP from cache (~10x cheaper on input) instead of re-sending it at full
    # price. The per-section context goes in a second, uncached block after it.
    iep_text = _iep_text_or_none(pdf_bytes)
    if iep_text:
        content = [
            {"type": "text",
             "text": "Full IEP text (reference for this and every other section):\n\n" + iep_text,
             "cache_control": {"type": "ephemeral"}},
            {"type": "text", "text": context_text},
        ]
    else:
        pdf_b64 = base64.standard_b64encode(pdf_bytes).decode("utf-8")
        content = [
            {"type": "document",
             "source": {"type": "base64", "media_type": "application/pdf", "data": pdf_b64},
             "cache_control": {"type": "ephemeral"}},
            {"type": "text", "text": context_text},
        ]

    message = client.messages.create(
        model=CLAUDE_MODEL,
        max_tokens=4000,  # one section's worth of detail — small and fast.
        system=SECTION_INSTRUCTIONS,
        tools=[SECTION_DETAIL_TOOL],
        tool_choice={"type": "tool", "name": "record_section_detail"},
        messages=[{"role": "user", "content": content}],
    )

    if message.stop_reason == "max_tokens":
        raise RuntimeError("That section's detail got cut off. Try again.")

    for block in message.content:
        if block.type == "tool_use" and block.name == "record_section_detail":
            detail = block.input
            # Source-level fix for the string-vs-array bug described above —
            # normalize once here so every consumer (email, PDF, frontend)
            # always receives a clean list, never a raw string.
            detail["services_that_support_it"] = _normalize_services(
                detail.get("services_that_support_it")
            )
            detail["why_it_falls_short"] = _as_points(detail.get("why_it_falls_short"))
            detail["why_this_target"] = _as_points(detail.get("why_this_target"))
            detail["what_to_ask_for"] = _as_points(detail.get("what_to_ask_for"))
            detail["model_language"] = _as_points(detail.get("model_language"))
            return detail

    raise RuntimeError("Claude did not return section detail — try again.")


def _as_points(value) -> list:
    """Normalize a field that may be a string or a list into a clean list of
    point strings (strips any stray leading numbering or dashes)."""
    import re as _re
    if isinstance(value, list):
        items = [str(v).strip() for v in value]
    elif isinstance(value, str):
        items = [p.strip() for p in _re.split(r"\n+", value)]
    else:
        return []
    out = []
    for it in items:
        it = _re.sub(r"^[\-\u2022\d.)\s]+", "", it).strip()
        if it:
            out.append(it)
    return out


def _normalize_services(value) -> list:
    """`services_that_support_it` is declared as an array in the schema, but
    Claude occasionally writes it as a single plain string instead. Left
    alone, Python's `for s in services` then iterates the string CHARACTER
    BY CHARACTER, producing one bullet per letter ('2', '0', '0', ' ',
    'm', 'i', 'n'...). Always run values through this before using them."""
    if isinstance(value, list):
        return [str(v) for v in value if str(v).strip()]
    if isinstance(value, str) and value.strip():
        return [value.strip()]
    return []


def _esc(value) -> str:
    """Minimal HTML-escaping for values we drop into the email body."""
    return (
        str(value if value is not None else "")
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
    )


def build_report_email_cover_html(report: dict) -> str:
    """Short cover message for the email — the FULL report now travels as a
    real PDF attachment (see build_report_pdf below) instead of being
    dumped into the email body. Inline styles only, since email inboxes
    strip <style> blocks."""
    return f"""
    <div style="font-family: -apple-system, Arial, sans-serif; color: #16261f; max-width: 560px; margin: 0 auto;">
      <h1 style="font-size: 22px;">Your IEP Audit Report</h1>
      <p style="color: #444;">Overall score: <b>{_esc(report.get('overall_score'))}/100</b> — {_esc(report.get('verdict'))}</p>
      <p>{_esc(report.get('summary'))}</p>
      <p style="margin-top: 18px;">Your full report — every section, the plain-language breakdown, the exact
      questions to ask, and the ready-to-paste IEP language — is attached to this email as a PDF.</p>
      <p style="color: #777; font-size: 12px; margin-top: 28px;">
        AuditMyIEP is an educational tool, not legal advice, and not a substitute for a
        special-education attorney or advocate. This email was sent because you asked
        for a copy of your report. If you also opted in for updates and no longer want
        them, reply to this email or write help@auditmyiep.com and you'll be removed.
      </p>
    </div>
    """


# --------------------------------------------------------------------------
# PDF GENERATION — builds the exact same report as a real PDF file, used
# both for the email attachment and for the in-app "Download PDF" button
# (see /api/report-pdf below). Using ONE function for both means the email
# copy and the downloaded copy are always identical, and it replaces the
# old browser print-to-PDF path, which was cutting sections in half across
# page breaks. reportlab's KeepTogether keeps each box (a question, the
# model language, etc.) from ever being split across two pages, and a
# PageBreak before each section gives every section a clean start.
# --------------------------------------------------------------------------

PAGE_MARGIN = 0.7 * inch
CONTENT_WIDTH = LETTER[0] - (2 * PAGE_MARGIN)

TEAL = colors.HexColor("#0e4d3f")
GOLD_TEXT = colors.HexColor("#8a5a1e")
GOLD_BG = colors.HexColor("#f6f3ea")
GOLD_BORDER = colors.HexColor("#d8cfa8")
ROSE_BG = colors.HexColor("#f8e5e1")
ROSE_BORDER = colors.HexColor("#dba299")
ROSE_TEXT = colors.HexColor("#a1352a")
BRAND_BG = colors.HexColor("#e9f3f0")
BRAND_BORDER = TEAL
MUTED = colors.HexColor("#666666")


# Brand fonts for the PDF (Fraunces display + Plus Jakarta Sans body), embedded
# from backend/fonts/. Falls back to Helvetica if the files are missing, so the
# PDF always builds.
_FONT_DIR = os.path.join(os.path.dirname(__file__), "fonts")
HEAD_FONT, BODY_FONT, BODY_BOLD, LABEL_FONT = "Helvetica-Bold", "Helvetica", "Helvetica-Bold", "Helvetica-Bold"
try:
    from reportlab.pdfbase import pdfmetrics as _pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont as _TTFont
    _pdfmetrics.registerFont(_TTFont("Fraunces", os.path.join(_FONT_DIR, "fraunces-600.ttf")))
    _pdfmetrics.registerFont(_TTFont("Fraunces-Bold", os.path.join(_FONT_DIR, "fraunces-700.ttf")))
    _pdfmetrics.registerFont(_TTFont("Jakarta", os.path.join(_FONT_DIR, "jakarta-400.ttf")))
    _pdfmetrics.registerFont(_TTFont("Jakarta-Bold", os.path.join(_FONT_DIR, "jakarta-700.ttf")))
    _pdfmetrics.registerFont(_TTFont("Jakarta-XBold", os.path.join(_FONT_DIR, "jakarta-800.ttf")))
    _pdfmetrics.registerFontFamily("Jakarta", normal="Jakarta", bold="Jakarta-Bold", italic="Jakarta", boldItalic="Jakarta-Bold")
    _pdfmetrics.registerFontFamily("Fraunces", normal="Fraunces", bold="Fraunces-Bold")
    HEAD_FONT, BODY_FONT, BODY_BOLD, LABEL_FONT = "Fraunces", "Jakarta", "Jakarta-Bold", "Jakarta-XBold"
except Exception:
    pass


def _grade_hex(grade: str) -> str:
    if grade == "Strong":
        return "#1f7a4c"
    if grade == "Needs work":
        return "#a15c14"
    return "#a1352a"  # Weak / Missing


def _score_color_hex(score) -> str:
    try:
        s = float(score)
    except (TypeError, ValueError):
        s = 0.0
    if s >= 85:
        return "#1f7a4c"
    if s >= 65:
        return "#a15c14"
    if s >= 45:
        return "#c9622c"
    return "#a1352a"


def _score_bar(score, width, height=7):
    """A thin rounded progress bar. Prints fine in black & white because the
    fill LENGTH conveys the score even without the color."""
    try:
        s = max(0.0, min(100.0, float(score)))
    except (TypeError, ValueError):
        s = 0.0
    d = Drawing(width, height)
    d.add(Rect(0, 0, width, height, rx=height / 2, ry=height / 2,
               fillColor=colors.HexColor("#e6e9e7"), strokeColor=None))
    fill_w = max(height, s / 100.0 * width)
    d.add(Rect(0, 0, fill_w, height, rx=height / 2, ry=height / 2,
               fillColor=colors.HexColor(_score_color_hex(s)), strokeColor=None))
    return d


def _pdf_styles():
    base = getSampleStyleSheet()
    return {
        "eyebrow": ParagraphStyle("EyebrowX", parent=base["BodyText"], fontName=LABEL_FONT, fontSize=10.5, leading=13, textColor=GOLD_TEXT, spaceAfter=2),
        "title": ParagraphStyle("TitleX", parent=base["Title"], fontName=HEAD_FONT, fontSize=26, leading=30, textColor=TEAL, spaceAfter=6),
        "h2": ParagraphStyle("H2X", parent=base["Heading2"], fontName=HEAD_FONT, fontSize=15, leading=19, textColor=TEAL, spaceBefore=2, spaceAfter=4),
        "h3": ParagraphStyle("H3X", parent=base["Heading3"], fontName=HEAD_FONT, fontSize=13, leading=16, textColor=TEAL, spaceBefore=6, spaceAfter=3),
        "body": ParagraphStyle("BodyX", parent=base["BodyText"], fontName=BODY_FONT, fontSize=10.3, leading=14.8, alignment=TA_LEFT),
        "muted": ParagraphStyle("MutedX", parent=base["BodyText"], fontName=BODY_FONT, fontSize=9, leading=12.5, textColor=MUTED),
        "label": ParagraphStyle("LabelX", parent=base["BodyText"], fontName=LABEL_FONT, fontSize=11.5, leading=14, textColor=TEAL, spaceAfter=3),
        "roseLabel": ParagraphStyle("RoseLabelX", parent=base["BodyText"], fontName=LABEL_FONT, fontSize=12.5, leading=15, textColor=ROSE_TEXT, spaceAfter=3),
        "brandLabel": ParagraphStyle("BrandLabelX", parent=base["BodyText"], fontName=LABEL_FONT, fontSize=12.5, leading=15, textColor=TEAL, spaceAfter=3),
        "small_bold": ParagraphStyle("SmallBoldX", parent=base["BodyText"], fontName=BODY_BOLD, fontSize=9.5, leading=13),
        "tilenum": ParagraphStyle("TileNumX", parent=base["BodyText"], fontName=HEAD_FONT, fontSize=16, leading=18),
        "bandtitle": ParagraphStyle("BandTitleX", parent=base["BodyText"], fontName=HEAD_FONT, fontSize=15.5, leading=18, textColor=colors.white),
        "bandmeta": ParagraphStyle("BandMetaX", parent=base["BodyText"], fontName=BODY_FONT, fontSize=8.5, leading=11, textColor=colors.HexColor("#cfe0d8")),
        "bandgrade": ParagraphStyle("BandGradeX", parent=base["BodyText"], fontName=LABEL_FONT, fontSize=12, leading=14, textColor=colors.white, alignment=2),
    }


def _box(flowables, bg, border, split=False):
    """Wraps flowables in a colored, bordered box.
    split=True returns the flowables list directly (no Table) so long
    content can span pages without crashing; caller must use story.extend()."""
    if split:
        return flowables  # ReportLab splits these naturally across pages
    t = Table([[flowables]], colWidths=[CONTENT_WIDTH - 0.1 * inch])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), bg),
        ("BOX", (0, 0), (-1, -1), 1, border),
        ("LEFTPADDING", (0, 0), (-1, -1), 10),
        ("RIGHTPADDING", (0, 0), (-1, -1), 10),
        ("TOPPADDING", (0, 0), (-1, -1), 8),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ]))
    return t


def build_report_pdf(report: dict, section_details: dict) -> bytes:
    styles = _pdf_styles()
    buf = BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=LETTER,
        topMargin=PAGE_MARGIN, bottomMargin=PAGE_MARGIN,
        leftMargin=PAGE_MARGIN, rightMargin=PAGE_MARGIN,
        title="AuditMyIEP Report",
    )
    story = []

    # ---- Cover: overall score, summary, strengths, weak points ----
    ov = report.get("overall_score")
    story.append(Paragraph("AUDITMYIEP", styles["eyebrow"]))
    story.append(Paragraph("Your IEP Audit Report", styles["title"]))
    story.append(Paragraph(f'Overall score: <b><font color="{_score_color_hex(ov)}">{_esc(ov)}/100</font></b> — {_esc(report.get("verdict"))}', styles["body"]))
    story.append(Spacer(1, 5))
    story.append(_score_bar(ov, CONTENT_WIDTH, 9))
    story.append(Spacer(1, 12))

    _comp = report.get("compliance_score")
    _enf = report.get("enforceability_score")
    _half = (CONTENT_WIDTH - 0.3 * inch) / 2
    _subtbl = Table([[
        [Paragraph(f'<b>Compliance</b> &nbsp; <font color="{_score_color_hex(_comp)}">{_esc(_comp)}/100</font>', styles["small_bold"]), Spacer(1, 3), _score_bar(_comp, _half, 7)],
        [Paragraph(f'<b>Enforceability</b> &nbsp; <font color="{_score_color_hex(_enf)}">{_esc(_enf)}/100</font>', styles["small_bold"]), Spacer(1, 3), _score_bar(_enf, _half, 7)],
    ]], colWidths=[_half + 0.3 * inch, _half])
    _subtbl.setStyle(TableStyle([
        ("LEFTPADDING", (0, 0), (0, 0), 0), ("RIGHTPADDING", (0, 0), (0, 0), 0.3 * inch),
        ("LEFTPADDING", (1, 0), (1, 0), 0), ("RIGHTPADDING", (1, 0), (1, 0), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 0), ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ]))
    story.append(_subtbl)
    story.append(Spacer(1, 14))

    story.append(Paragraph(_esc(report.get("summary")), styles["body"]))
    story.append(Spacer(1, 14))

    _cover_sections = report.get("sections") or []
    if _cover_sections:
        story.append(Paragraph("Every section at a glance", styles["h3"]))
        story.append(Spacer(1, 5))
        _rows = []
        for _sec in _cover_sections:
            _sc = _sec.get("section_score")
            _rows.append([
                Paragraph(_esc(_sec.get("section_name")), styles["body"]),
                Paragraph(f'<font color="{_grade_hex(_sec.get("grade") or "Needs work")}"><b>{_esc(_sec.get("grade"))}</b></font>', styles["small_bold"]),
                Paragraph(f'<b>{_esc(_sc)}</b>', styles["small_bold"]),
                _score_bar(_sc, 1.7 * inch, 7),
            ])
        _sctbl = Table(_rows, colWidths=[CONTENT_WIDTH - 3.2 * inch, 1.0 * inch, 0.5 * inch, 1.7 * inch])
        _sctbl.setStyle(TableStyle([
            ("LINEBELOW", (0, 0), (-1, -2), 0.4, colors.HexColor("#e2e6e4")),
            ("TOPPADDING", (0, 0), (-1, -1), 5), ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
            ("LEFTPADDING", (0, 0), (0, -1), 0),
            ("ALIGN", (2, 0), (2, -1), "RIGHT"),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ]))
        story.append(_sctbl)
        story.append(Spacer(1, 16))
    story.append(Paragraph("Genuinely strong", styles["h3"]))
    story.append(Paragraph(_esc(report.get("strengths")), styles["body"]))
    story.append(Spacer(1, 12))

    weak_points = report.get("weak_points") or []
    if weak_points:
        story.append(Paragraph(f"The {len(weak_points)} weak points that matter most", styles["h3"]))
        items = [ListItem(Paragraph(_esc(w), styles["body"]), value=idx + 1) for idx, w in enumerate(weak_points)]
        story.append(ListFlowable(items, bulletType="1", start=1, leftIndent=18))

    story.append(Spacer(1, 16))
    story.append(Paragraph(
        "AuditMyIEP is an educational guide to help you advocate for your child. "
        "It is NOT legal advice and NOT a substitute for a special-education attorney or advocate.",
        styles["muted"],
    ))

    # ---- One page (or more) per section ----
    sections = report.get("sections") or []
    for i, section in enumerate(sections):
        story.append(PageBreak())
        detail = section_details.get(str(i)) or {}
        grade = section.get("grade") or "Needs work"
        gcolor = _grade_hex(grade)

        _band = Table([[
            [Paragraph(_esc(section.get("section_name")), styles["bandtitle"]),
             Paragraph(f'begins p. {_esc(section.get("page_number"))}', styles["bandmeta"])],
            Paragraph(_esc(grade), styles["bandgrade"]),
        ]], colWidths=[CONTENT_WIDTH * 0.72, CONTENT_WIDTH * 0.28])
        _band.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, -1), TEAL),
            ("ROUNDEDCORNERS", [9, 9, 0, 0]),
            ("LEFTPADDING", (0, 0), (-1, -1), 14), ("RIGHTPADDING", (0, 0), (-1, -1), 14),
            ("TOPPADDING", (0, 0), (-1, -1), 11), ("BOTTOMPADDING", (0, 0), (-1, -1), 11),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("ALIGN", (1, 0), (1, 0), "RIGHT"),
        ]))
        story.append(_band)
        _accent = Table([[""]], colWidths=[CONTENT_WIDTH], rowHeights=[4])
        _accent.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, -1), colors.HexColor(gcolor))]))
        story.append(_accent)
        story.append(Spacer(1, 11))
        _third = (CONTENT_WIDTH - 0.5 * inch) / 3

        def _sec_tile(_lbl, _val):
            return [
                Paragraph(f"<b>{_lbl}</b>", styles["small_bold"]),
                Spacer(1, 1),
                Paragraph(f'<font color="{_score_color_hex(_val)}">{_esc(_val)}</font><font size=8 color="#888888">/100</font>', styles["tilenum"]),
                Spacer(1, 3),
                _score_bar(_val, _third, 7),
            ]

        _tiletbl = Table([[
            _sec_tile("Section score", section.get("section_score")),
            _sec_tile("Compliance", section.get("compliance_score")),
            _sec_tile("Enforceability", section.get("enforceability_score")),
        ]], colWidths=[_third + 0.25 * inch, _third + 0.25 * inch, _third])
        _tiletbl.setStyle(TableStyle([
            ("LEFTPADDING", (0, 0), (0, 0), 0),
            ("LEFTPADDING", (1, 0), (-1, 0), 0.25 * inch),
            ("RIGHTPADDING", (0, 0), (-1, -1), 0),
            ("TOPPADDING", (0, 0), (-1, -1), 0), ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ]))
        story.append(_tiletbl)
        story.append(Spacer(1, 12))
        story.append(Paragraph(f"<b>What we found:</b> {_esc(section.get('what_we_found'))}", styles["body"]))
        story.append(Spacer(1, 6))
        story.append(_box([Paragraph(f"<b>Your move:</b> {_esc(section.get('your_move'))}", styles["body"])], GOLD_BG, GOLD_BORDER))
        story.append(Spacer(1, 6))

        legal_line = _esc(section.get("legal_basis"))
        if section.get("citation"):
            legal_line += f' &nbsp; <font color="#0e4d3f"><b>[{_esc(section.get("citation"))}]</b></font>'
        story.append(Paragraph(legal_line, styles["muted"]))

        if not detail:
            story.append(Spacer(1, 10))
            story.append(Paragraph(
                "<i>This section's deeper advocacy detail wasn't open when this report was generated.</i>",
                styles["muted"],
            ))
            continue

        # NOTE ON STRUCTURE: each piece below is its OWN small colored box,
        # appended directly to the top-level story (never a box nested
        # inside another box's cell). reportlab's Table-cell layout engine
        # can't reliably size a KeepTogether group that's nested inside
        # another Table's cell — it was measuring some boxes as effectively
        # infinite height and crashing. Keeping every box a sibling, each
        # wrapped in its own top-level KeepTogether, avoids that entirely
        # while still giving the same "everything about advocating for this
        # section lives in the pink zone" visual grouping Anna asked for.
        services = _normalize_services(detail.get("services_that_support_it"))
        story.append(Spacer(1, 10))

        understand_lines = [
            Paragraph("UNDERSTAND IT &amp; HOW TO ADVOCATE", styles["roseLabel"]),
            Spacer(1, 6),
            Paragraph("In plain terms", styles["label"]),
            Paragraph(_esc(detail.get("in_plain_terms")), styles["body"]),
            Spacer(1, 6),
            Paragraph("Why it falls short" if grade != "Strong" else "Why it holds up", styles["label"]),
        ]
        _fs_pts = _as_points(detail.get("why_it_falls_short"))
        if len(_fs_pts) > 1:
            for _i, _p in enumerate(_fs_pts, 1):
                understand_lines.append(Paragraph(f"{_i}. {_esc(_p)}", styles["body"]))
        elif _fs_pts:
            understand_lines.append(Paragraph(_esc(_fs_pts[0]), styles["body"]))
        story.extend(_box(understand_lines, ROSE_BG, ROSE_BORDER, split=True))
        story.append(Spacer(1, 8))

        script_flow = [Paragraph("QUESTIONS TO ASK, IN ORDER", styles["roseLabel"]), Spacer(1, 4)]
        script_steps = [
            ("1. Start here", detail.get("ask_start")),
            ("2. If the answer is vague", detail.get("ask_if_vague")),
            ("3. If they still won't commit", detail.get("ask_if_stuck")),
        ]
        for step_label, step_text in script_steps:
            if step_text:
                script_flow.append(Paragraph(f"<b>{step_label}:</b> {_esc(step_text)}", styles["body"]))
                script_flow.append(Spacer(1, 4))
        story.extend(_box(script_flow, ROSE_BG, ROSE_BORDER, split=True))
        story.append(Spacer(1, 8))

        final_ask_lines = [Paragraph("YOUR FINAL ASK", styles["brandLabel"]), Spacer(1, 4)]
        has_final_ask = False
        _ask_pts = _as_points(detail.get("what_to_ask_for"))
        if _ask_pts:
            final_ask_lines.append(Paragraph("<b>The change to request:</b>", styles["label"]))
            if len(_ask_pts) > 1:
                for _i, _p in enumerate(_ask_pts, 1):
                    final_ask_lines.append(Paragraph(f"{_i}. {_esc(_p)}", styles["body"]))
            else:
                final_ask_lines.append(Paragraph(_esc(_ask_pts[0]), styles["body"]))
            final_ask_lines.append(Spacer(1, 4))
            has_final_ask = True
        _wt_pts = _as_points(detail.get("why_this_target"))
        if _wt_pts:
            final_ask_lines.append(Paragraph("<b>Why this fits this child:</b>", styles["label"]))
            if len(_wt_pts) > 1:
                for _i, _p in enumerate(_wt_pts, 1):
                    final_ask_lines.append(Paragraph(f"{_i}. {_esc(_p)}", styles["body"]))
            else:
                final_ask_lines.append(Paragraph(_esc(_wt_pts[0]), styles["body"]))
            final_ask_lines.append(Spacer(1, 4))
            has_final_ask = True
        if section.get("citation"):
            final_ask_lines.append(Paragraph(
                f"<b>The law behind it:</b> {_esc(section.get('legal_basis'))} ({_esc(section.get('citation'))})",
                styles["body"],
            ))
            has_final_ask = True
        if has_final_ask:
            story.extend(_box(final_ask_lines, BRAND_BG, BRAND_BORDER, split=True))
            story.append(Spacer(1, 8))

        track_flow = [Paragraph("HOW PROGRESS GETS TRACKED", styles["roseLabel"]), Spacer(1, 4)]
        has_track = False
        if detail.get("how_progress_is_tracked"):
            track_flow.append(Paragraph(_esc(detail.get("how_progress_is_tracked")), styles["body"]))
            has_track = True
        if services:
            if has_track:
                track_flow.append(Spacer(1, 5))
            track_flow.append(Paragraph("<b>Services that back this up:</b>", styles["body"]))
            track_flow.append(ListFlowable(
                [ListItem(Paragraph(_esc(s), styles["body"])) for s in services],
                bulletType="bullet", leftIndent=16,
            ))
            has_track = True
        if has_track:
            story.extend(_box(track_flow, ROSE_BG, ROSE_BORDER, split=True))
            story.append(Spacer(1, 8))

        _model_pts = _as_points(detail.get("model_language"))
        if _model_pts:
            model_lines = [
                Paragraph("EXACT LANGUAGE TO COPY INTO THE IEP", styles["label"]), Spacer(1, 4),
            ]
            if len(_model_pts) > 1:
                for _i, _p in enumerate(_model_pts, 1):
                    model_lines.append(Paragraph(f"{_i}. {_esc(_p)}", styles["body"]))
            else:
                model_lines.append(Paragraph(_esc(_model_pts[0]), styles["body"]))
            story.extend(_box(model_lines, GOLD_BG, GOLD_BORDER, split=True))

    doc.build(story)
    return buf.getvalue()


def send_email(to_email: str, subject: str, html_body: str, attachment=None) -> None:
    """The only place this app sends email. Uses Resend's HTTP API (port 443)
    because Railway blocks the SMTP ports Zoho needs. `attachment`, if given,
    is (pdf_bytes, filename) and is attached as a real PDF file. Raises
    RuntimeError with a parent-safe message on any failure."""
    if not RESEND_API_KEY:
        raise RuntimeError(
            "Email sending isn't set up yet on this server (missing RESEND_API_KEY)."
        )

    import json
    import urllib.request
    import urllib.error

    payload = {
        "from": RESEND_FROM,
        "to": [to_email],
        "subject": subject,
        "html": html_body,
    }

    if attachment:
        pdf_bytes, filename = attachment
        payload["attachments"] = [{
            "filename": filename,
            "content": base64.standard_b64encode(pdf_bytes).decode("utf-8"),
        }]

    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        "https://api.resend.com/emails",
        data=data,
        headers={
            "Authorization": f"Bearer {RESEND_API_KEY}",
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "AuditMyIEP/1.0",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            resp.read()  # 200 OK — email accepted by Resend
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        raise RuntimeError(f"Could not send the email: {e.code} {body}")
    except Exception as e:
        raise RuntimeError(f"Could not send the email: {e}")


def append_marketing_email(email: str) -> None:
    """Appends ONE row — email + date — to a local CSV. Nothing else about
    the parent or their child is ever written here. Skips an email already
    on the list so one buyer is never added twice. Creates the file with a
    header the first time it's needed."""
    email = email.strip()
    if not email:
        return
    is_new = not os.path.exists(MARKETING_LIST_PATH)
    if not is_new:
        try:
            with open(MARKETING_LIST_PATH, newline="") as f:
                for row in csv.reader(f):
                    if row and row[0].strip().lower() == email.lower():
                        return  # already on the list
        except OSError:
            pass
    with open(MARKETING_LIST_PATH, "a", newline="") as f:
        writer = csv.writer(f)
        if is_new:
            writer.writerow(["email", "collected_at_utc"])
        writer.writerow([email, datetime.now(timezone.utc).isoformat()])


def _read_uploaded_pdf():
    """Shared validation for both routes. Returns (pdf_bytes, error_response).

    Guards here protect BOTH quality and your API cost: only a real PDF is
    accepted (a photo/image renamed .pdf is rejected), and an oversized or
    huge-page-count file is turned away before it's ever sent to Claude —
    because every page becomes tokens you pay for."""
    uploaded = request.files.get("iep_pdf")

    if uploaded is None or uploaded.filename == "":
        return None, (jsonify({"error": "Please choose a PDF file to upload."}), 400)

    if not uploaded.filename.lower().endswith(".pdf"):
        return None, (jsonify({"error": "Please upload your IEP as a PDF. Photos or image files (JPG, PNG, HEIC) won't work here. If you only have paper, use your phone's built-in scan-to-PDF or a free scanner app to make a PDF first."}), 400)

    # .read() loads the bytes into memory only — nothing is written to disk,
    # and `uploaded` / the returned bytes fall out of scope (and get garbage
    # collected) the moment the calling function returns.
    pdf_bytes = uploaded.read()

    # A real PDF always starts with the bytes "%PDF-". This catches an image
    # (or anything else) that was simply renamed to end in .pdf.
    if not pdf_bytes[:5] == b"%PDF-":
        return None, (jsonify({"error": "That file isn't a real PDF (it may be a photo or image renamed to .pdf). Please upload an actual PDF of the IEP."}), 400)

    if len(pdf_bytes) > MAX_FILE_BYTES:
        return None, (jsonify({"error": "That PDF is larger than 25MB. If it's a scan, try a lower-resolution or text-based PDF."}), 400)

    # Page-count guard — a normal IEP is ~10–30 pages. A giant packet would
    # cost far more to process than a single audit fee, so cap it. If pypdf
    # isn't available or the file won't parse, we skip the check rather than
    # block a legitimate upload.
    if PdfReader is not None:
        try:
            n_pages = len(PdfReader(BytesIO(pdf_bytes)).pages)
            if n_pages > MAX_PDF_PAGES:
                return None, (jsonify({"error": f"That PDF has {n_pages} pages. Please upload just your child's IEP (up to {MAX_PDF_PAGES} pages), not the full records packet."}), 400)
        except Exception:
            pass

    return pdf_bytes, None


@app.route("/api/stripe-config", methods=["GET"])
def stripe_config():
    """The page asks this on load to learn whether payments are on, the
    publishable key to talk to Stripe with, and the price to show. The
    publishable key is safe to expose — that's what it's designed for."""
    return jsonify({
        "enabled": PAYMENTS_ENABLED,
        "publishable_key": STRIPE_PUBLISHABLE_KEY or "",
        "amount_cents": AUDIT_PRICE_CENTS,
    })


@app.route("/api/create-payment-intent", methods=["POST"])
def create_payment_intent():
    """Creates a one-time PaymentIntent for the audit price and hands the
    browser the client_secret it needs to show the card form. No card data
    ever touches this server."""
    if not PAYMENTS_ENABLED:
        return jsonify({"error": "Payments aren't set up on this server."}), 400

    payload = request.get_json(silent=True) or {}
    email = (payload.get("email") or "").strip()

    try:
        intent = stripe.PaymentIntent.create(
            amount=AUDIT_PRICE_CENTS,
            currency="usd",
            description="AuditMyIEP — one IEP audit",
            receipt_email=email or None,
            # Card-only is enforced on the client: the frontend uses Stripe's
            # classic CardElement with confirmCardPayment, which submits only a
            # card. Stripe retired the payment_method_types parameter (payment
            # methods are now managed in the Dashboard), so we enable automatic
            # payment methods but forbid redirect-based ones — keeping the flow
            # on-page with no Link, wallet, or "enter a code" step.
            automatic_payment_methods={"enabled": True, "allow_redirects": "never"},
            # MANUAL capture = the card is only AUTHORIZED (money held) at
            # payment time, NOT charged. We only actually capture (charge) it
            # after the audit successfully generates (see /api/audit). If the
            # audit fails, we never capture, so the parent is never charged —
            # the hold simply falls off. This is the "no report, no charge"
            # guarantee.
            capture_method="manual",
        )
    except Exception as e:
        return jsonify({"error": f"Could not start the payment: {e}"}), 502

    return jsonify({"client_secret": intent.client_secret, "payment_intent_id": intent.id})


@app.route("/api/audit", methods=["POST"])
def audit():
    pdf_bytes, error = _read_uploaded_pdf()
    if error:
        return error

    # Payment gate — must have a real, unused, paid PaymentIntent (skipped
    # entirely in FREE mode when Stripe keys aren't configured).
    payment_intent_id = request.form.get("payment_intent_id", "")
    pay_error = _verify_paid_or_error(payment_intent_id)
    if pay_error:
        return pay_error

    email = (request.form.get("email", "") or "").strip()

    # Start the audit in a background thread and return a job_id immediately.
    # This means no HTTP timeout no matter how large the IEP — the frontend
    # polls /api/audit-status/<job_id> until the result is ready.
    # Payment capture (and saving the purchaser email) happens inside the
    # background thread, only on success.
    job_id = str(_uuid_mod.uuid4())
    with _jobs_lock:
        _jobs[job_id] = {"status": "pending"}

    thread = threading.Thread(
        target=_run_audit_job,
        args=(job_id, pdf_bytes, payment_intent_id, email),
        daemon=True,
    )
    thread.start()
    return jsonify({"job_id": job_id})


@app.route("/api/audit-status/<job_id>", methods=["GET"])
def audit_status(job_id):
    """Polling endpoint — returns pending/done/error for a background audit job."""
    with _jobs_lock:
        job = _jobs.get(job_id)

    if job is None:
        return jsonify({"status": "not_found"}), 404

    if job["status"] == "done":
        with _jobs_lock:
            _jobs.pop(job_id, None)  # free memory once result is read
        return jsonify({"status": "done", "report": job["report"]})

    if job["status"] == "error":
        with _jobs_lock:
            _jobs.pop(job_id, None)
        return jsonify({"status": "error", "error": job.get("error", "Unknown error")}), 502

    return jsonify({"status": "pending"})


@app.route("/api/section-detail", methods=["POST"])
def section_detail():
    pdf_bytes, error = _read_uploaded_pdf()
    if error:
        return error

    section_context = {
        "section_name": request.form.get("section_name", ""),
        "page_number": request.form.get("page_number", ""),
        "grade": request.form.get("grade", ""),
        "what_we_found": request.form.get("what_we_found", ""),
        "your_move": request.form.get("your_move", ""),
    }

    try:
        detail = run_section_detail(pdf_bytes, section_context)
    except anthropic.APIError as e:
        return jsonify({"error": f"Claude API error: {e}"}), 502
    except RuntimeError as e:
        return jsonify({"error": str(e)}), 502

    # Same as above — nothing about this section or this family's IEP is
    # kept after this response goes out.
    return jsonify({"detail": detail})


@app.route("/api/email-report", methods=["POST"])
def email_report():
    """Sends a parent a copy of THEIR OWN already-generated report. The
    report and section details are sent to us in this one request (the
    browser already has them in memory) — nothing is read from disk or a
    database, and nothing about the report itself is saved after this
    request finishes. The only thing that can persist is the email address
    itself, and only if marketing_opt_in is true."""
    payload = request.get_json(silent=True) or {}

    to_email = (payload.get("to_email") or "").strip()
    report = payload.get("report") or {}
    section_details = payload.get("section_details") or {}
    marketing_opt_in = bool(payload.get("marketing_opt_in"))

    if not EMAIL_RE.match(to_email):
        return jsonify({"error": "That doesn't look like a valid email address."}), 400

    if not report.get("sections"):
        return jsonify({"error": "There's no report to email yet — run an audit first."}), 400

    try:
        pdf_bytes = build_report_pdf(report, section_details)
        html_body = build_report_email_cover_html(report)
        send_email(
            to_email, "Your IEP Audit Report — AuditMyIEP", html_body,
            attachment=(pdf_bytes, "AuditMyIEP_Report.pdf"),
        )
    except RuntimeError as e:
        return jsonify({"error": str(e)}), 502
    except Exception as e:
        return jsonify({"error": f"Could not build the report PDF: {e}"}), 502

    if marketing_opt_in:
        try:
            append_marketing_email(to_email)
        except OSError as e:
            # The email still sent successfully — don't fail the request
            # over the marketing list, just say so.
            return jsonify({"sent": True, "marketing_saved": False, "warning": str(e)})

    return jsonify({"sent": True, "marketing_saved": marketing_opt_in})


@app.route("/api/report-pdf", methods=["POST"])
def report_pdf():
    """Builds the same report as a downloadable PDF — this is what the
    'Download PDF' button calls. Same privacy boundary as everything else:
    the report/section_details arrive in this one request (the browser
    already has them in memory) and nothing is kept after the response
    goes out."""
    payload = request.get_json(silent=True) or {}
    report = payload.get("report") or {}
    section_details = payload.get("section_details") or {}

    if not report.get("sections"):
        return jsonify({"error": "There's no report to download yet — run an audit first."}), 400

    try:
        pdf_bytes = build_report_pdf(report, section_details)
    except Exception as e:
        return jsonify({"error": f"Could not build the PDF: {e}"}), 502

    return Response(
        pdf_bytes,
        mimetype="application/pdf",
        headers={"Content-Disposition": "attachment; filename=AuditMyIEP_Report.pdf"},
    )


# Serve React frontend in production
FRONTEND_DIST = os.path.join(os.path.dirname(__file__), '..', 'frontend', 'dist')

BACKEND_DIR = os.path.dirname(__file__)


@app.route('/og-image.png')
def og_image():
    # The link-preview (Open Graph) image shared on texts/social. Served from
    # the backend dir; defined before serve_react so the catch-all doesn't
    # swallow it and return index.html.
    return send_from_directory(BACKEND_DIR, 'og-image.png')

@app.route('/', defaults={'path': ''})
@app.route('/<path:path>')
def serve_react(path):
    if path.startswith('api/'):
        return jsonify({"error": "Not found"}), 404
    # Home page is the marketing landing page; the audit app lives at /audit
    # (and every other non-file path falls through to the React app).
    if path == '':
        return send_from_directory(BACKEND_DIR, 'landing.html')
    full = os.path.join(FRONTEND_DIST, path)
    if path and os.path.exists(full):
        return send_from_directory(FRONTEND_DIST, path)
    return send_from_directory(FRONTEND_DIST, 'index.html')

@app.route("/api/health", methods=["GET"])
def health():
    return jsonify({"status": "ok"})


if __name__ == "__main__":
    # threaded=True matters here: Print and Email both fire one request per
    # IEP section (up to ~11) at the same time. Without this, Flask's dev
    # server handles them ONE AT A TIME, so 11 sequential Claude calls can
    # take many minutes and the Print button looks stuck when it's really
    # just queued.
    app.run(debug=True, port=5001, threaded=True)
