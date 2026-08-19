import type { Email } from "../jmap/index.js";

// Deterministic pre-triage rules, applied before (or instead of) the LLM
// classifier. Each rule earned its place with window-1 behavioral counts —
// see docs/LEARNING-LOG.md. Policy changes only at deploys, so the rules are
// code constants, versioned by commit.

/**
 * Senders whose emails stay in the inbox instead of being routed away.
 * Gate: observed rescue history (window 1: 14 of 18 digest rescues), NOT the
 * content_format signal — that over-fired on 12 of 28 essays nobody touched.
 * content_format remains the candidate generator for future windows.
 */
export const PROMOTED_SENDERS = new Set([
  "email@stratechery.com",
  "70s-sci-fi-art@ghost.io",
  "theleverage@substack.com",
  "hello@readwise.io",
]);

/** Sender whose threads are classified once and collapsed in digests. */
export const GITHUB_SENDER = "notifications@github.com";

export interface OtpDetection {
  code: string | null;
}

// Subject patterns for one-time codes, built from the window-1 corpus:
// "Your SafeKey Verification Code", "AAYGQN is your verification code"
// (Booking.com), "Your SIXT code: 515287", "Your one-time Ocado code",
// "Sign in to 70s Sci-Fi Art with code 067188".
// Precision matters more than recall here: a false positive is auto-trashed
// mail. The qualifier must sit within 30 chars of "code" (kills "Verify your
// email to get your discount code"), and the literal form requires digits
// directly after "code" (kills "use code SAVE20"). Every detection lands in
// processed_emails with action_taken='otp-*', so precision is auditable in
// each analysis window.
const OTP_QUALIFIER =
  /\b(verification|verify|one[- ]?time|sign[- ]?in|log[- ]?in|2fa|authentication|passcode|otp)\b[\w\s.,'-]{0,30}\bcode\b/i;
const OTP_CODE_LITERAL = /\bcode:?\s*\d{4,8}\b/i;

/**
 * Detect one-time-code emails from the subject line alone. Returns null for
 * non-OTP mail. Precedence note: this check MUST run before sender promotion —
 * 70s-sci-fi-art@ghost.io sends both essays (promote) and sign-in codes
 * (bypass), and in window 1 the user deleted its codes while rescuing its
 * essays.
 */
export function detectOtp(email: Email): OtpDetection | null {
  const subject = email.subject ?? "";
  if (!OTP_QUALIFIER.test(subject) && !OTP_CODE_LITERAL.test(subject)) {
    return null;
  }

  // Best-effort code extraction: digits first, then a Booking.com-style
  // leading alphanumeric token ("AAYGQN is your verification code").
  const digits = subject.match(/\b(\d{4,8})\b/);
  if (digits) return { code: digits[1] };
  const leading = subject.match(/\b([A-Z0-9]{5,8})\b\s+is your\b/i);
  return { code: leading ? leading[1] : null };
}

/** How long a one-time code stays in the inbox before auto-deletion. */
export const OTP_TTL_MS = 2 * 60 * 60 * 1000;
