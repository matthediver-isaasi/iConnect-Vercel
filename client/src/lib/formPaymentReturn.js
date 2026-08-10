// Task #3501: page-level payment return-leg handling.
//
// After a GoCardless hosted flow (or a Stripe 3DS redirect) the applicant
// lands back on the form URL with payment query params. The old handling
// lived inside FormPaymentSubmit, which only mounts on the form's LAST
// step — on return the wizard remounts at step 1, so the confirm call never
// fired and the user saw a blank "cleared" form. These helpers are
// React-free so the decision logic is unit-testable and shared by the page
// hook (FormView / EmbedForm) and the inline Stripe flow, which must not
// drift.

// Kept identical to the legacy key so an in-flight redirect started before a
// deploy still resolves.
export const SS_KEY = 'form_payment_pending_submission';

export const PAYMENT_RETURN_PARAMS = [
  'form_payment_submission',
  'form_payment_provider',
  'form_payment_cancelled',
  'payment_intent',
  'payment_intent_client_secret',
  'redirect_status',
];

/**
 * Decide what a page load's query string means for the payment return leg.
 * Pure: pass `search` (window.location.search) and the sessionStorage-backed
 * submission id (may be null).
 *
 * Returns one of:
 *  - { kind: 'none' }                       — not a payment return
 *  - { kind: 'cancelled' }                  — user exited the hosted flow
 *  - { kind: 'failed' }                     — Stripe redirect_status !== succeeded
 *  - { kind: 'confirm', submissionId, paymentIntentId } — call confirm
 *  - { kind: 'orphan' }                     — return params present but no
 *    submission id recoverable (params + sessionStorage both empty). The
 *    reconciliation sweep still finalizes server-side; show the pending copy.
 */
export function parsePaymentReturn(search, { storedSubmissionId = null } = {}) {
  const params = new URLSearchParams(search || '');
  const returnedSubmission = params.get('form_payment_submission');
  const cancelled = params.get('form_payment_cancelled');
  const piFromUrl = params.get('payment_intent');
  const redirectStatus = params.get('redirect_status');

  if (!returnedSubmission && !cancelled && !piFromUrl) return { kind: 'none' };
  if (cancelled) return { kind: 'cancelled' };
  if (piFromUrl && redirectStatus && redirectStatus !== 'succeeded') return { kind: 'failed' };

  const submissionId = returnedSubmission || storedSubmissionId || null;
  if (!submissionId) return { kind: 'orphan' };
  return { kind: 'confirm', submissionId, paymentIntentId: piFromUrl || null };
}

/** Strip the payment params from a query string; returns the cleaned search
 *  (with leading '?'), or '' when nothing remains. */
export function stripPaymentParams(search) {
  const params = new URLSearchParams(search || '');
  PAYMENT_RETURN_PARAMS.forEach((k) => params.delete(k));
  const rest = params.toString();
  return rest ? `?${rest}` : '';
}

export const CONFIRM_FALLBACK_ERROR =
  'Your payment was taken, but we could not confirm the submission. It will be reconciled automatically — please do NOT pay again.';

/**
 * Shared confirm call — the ONLY client code path that hits
 * action:'confirm'. Used by the page-level return hook and by the inline
 * Stripe (non-redirect) flow in FormPaymentSubmit.
 *
 * Returns { status: 'paid' | 'pending' | 'error', error? }.
 * 'paid' covers alreadyPaid repeats (refresh, reconciliation winning the
 * race) — the server responds 200 for those too.
 */
export async function confirmFormPayment({ submissionId, paymentIntentId = null, fetchImpl = fetch }) {
  try {
    const res = await fetchImpl('/api/public/form-payment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        action: 'confirm',
        submission_id: submissionId,
        ...(paymentIntentId ? { payment_intent_id: paymentIntentId } : {}),
      }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) return { status: 'error', error: json.error || CONFIRM_FALLBACK_ERROR };
    if (json.pending) return { status: 'pending' };
    try { sessionStorage.removeItem(SS_KEY); } catch { /* ignore */ }
    return { status: 'paid' };
  } catch {
    return { status: 'error', error: CONFIRM_FALLBACK_ERROR };
  }
}
