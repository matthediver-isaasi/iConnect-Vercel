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
export const PAYMENT_CONTEXT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const VERIFIED_PAYMENT_PROVIDERS = new Set([
  'stripe_monthly_card',
  'gocardless',
  'stripe',
]);
export const VERIFIED_PAYMENT_STATUSES = new Set([
  'pending',
  'finalizing',
  'setup_complete',
  'paid',
  'blocked',
  'accounting_pending',
]);

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
  const returnedProvider = params.get('form_payment_provider');
  const cancelled = params.get('form_payment_cancelled');
  const piFromUrl = params.get('payment_intent');
  const redirectStatus = params.get('redirect_status');

  if (!returnedSubmission && !returnedProvider && !cancelled && !piFromUrl) return { kind: 'none' };
  if (cancelled) return { kind: 'cancelled' };
  if (piFromUrl && redirectStatus && redirectStatus !== 'succeeded') return { kind: 'failed' };

  const submissionId = returnedSubmission || storedSubmissionId || null;
  if (!submissionId) return { kind: 'orphan' };
  return {
    kind: 'confirm',
    submissionId,
    paymentIntentId: piFromUrl || null,
    provider: VERIFIED_PAYMENT_PROVIDERS.has(returnedProvider) ? returnedProvider : null,
  };
}

export function paymentContextScope(
  pathname = typeof window !== 'undefined' ? window.location.pathname : '/',
  search = typeof window !== 'undefined' ? window.location.search : '',
) {
  return `${pathname || '/'}${stripPaymentParams(search)}`;
}

export function paymentContextKey(pathname = '/', search = '') {
  return `${SS_KEY}:${encodeURIComponent(paymentContextScope(pathname, search))}`;
}

/** Store only a submission id, provider hint and path. Never persist Stripe
 * client secrets/payment-intent details or submitted form answers. */
export function savePaymentSubmissionContext({
  submissionId,
  provider = null,
  pathname = typeof window !== 'undefined' ? window.location.pathname : '/',
  search = typeof window !== 'undefined' ? window.location.search : '',
  storage = typeof sessionStorage !== 'undefined' ? sessionStorage : null,
  now = Date.now(),
}) {
  if (!submissionId || !storage) return;
  const scope = paymentContextScope(pathname, search);
  const context = {
    submissionId,
    provider: VERIFIED_PAYMENT_PROVIDERS.has(provider) ? provider : null,
    scope,
    createdAt: now,
  };
  storage.setItem(paymentContextKey(pathname, search), JSON.stringify(context));
  // Preserve the old key for redirects already in flight, but keep it equally
  // non-secret and path-bound rather than writing a bare id.
  storage.setItem(SS_KEY, JSON.stringify(context));
}

export function loadPaymentSubmissionContext({
  pathname = typeof window !== 'undefined' ? window.location.pathname : '/',
  search = typeof window !== 'undefined' ? window.location.search : '',
  storage = typeof sessionStorage !== 'undefined' ? sessionStorage : null,
  now = Date.now(),
} = {}) {
  if (!storage) return null;
  const scope = paymentContextScope(pathname, search);
  const scoped = storage.getItem(paymentContextKey(pathname, search));
  const legacy = scoped || storage.getItem(SS_KEY);
  if (!legacy) return null;
  try {
    const parsed = JSON.parse(legacy);
    if (!parsed?.submissionId || parsed.scope !== scope
        || !Number.isFinite(parsed.createdAt)
        || now - parsed.createdAt > PAYMENT_CONTEXT_MAX_AGE_MS) return null;
    return {
      submissionId: parsed.submissionId,
      provider: VERIFIED_PAYMENT_PROVIDERS.has(parsed.provider) ? parsed.provider : null,
    };
  } catch {
    // A bare id is accepted only to finish an old redirect. It is deliberately
    // not used for refresh resume because the legacy value was not path-bound.
    return { submissionId: legacy, provider: null, legacy: true };
  }
}

export function clearPaymentSubmissionContext({
  pathname = typeof window !== 'undefined' ? window.location.pathname : '/',
  search = typeof window !== 'undefined' ? window.location.search : '',
  storage = typeof sessionStorage !== 'undefined' ? sessionStorage : null,
} = {}) {
  if (!storage) return;
  storage.removeItem(paymentContextKey(pathname, search));
  storage.removeItem(SS_KEY);
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
  'We could not verify the current payment status. Do not make another payment. Check this same submission again.';

/**
 * Shared confirm call — the ONLY client code path that hits
 * action:'confirm'. Used by the page-level return hook and by the inline
 * Stripe (non-redirect) flow in FormPaymentSubmit.
 *
 * Returns { status: 'paid' | 'pending' | 'processing' | 'error', error? }.
 * 'paid' covers alreadyPaid repeats (refresh, reconciliation winning the
 * race) — the server responds 200 for those too.
 */
export async function confirmFormPayment({
  submissionId,
  paymentIntentId = null,
  provider = null,
  fetchImpl = fetch,
}) {
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
    // Provider hints from the URL/session context are useful only for making
    // the request resumable. They are client-controlled and must never drive
    // provider-specific success/status copy.
    const verifiedProvider = VERIFIED_PAYMENT_PROVIDERS.has(json.provider)
      ? json.provider
      : null;
    let status = VERIFIED_PAYMENT_STATUSES.has(json.status) ? json.status : null;

    // Compatibility with the existing one-off response, which historically
    // returned success/alreadyPaid without an explicit status.
    if (!status && res.ok && json.pending) status = 'pending';
    if (!status && res.ok && (json.success === true || json.alreadyPaid === true)) status = 'paid';
    // A server-verified successful charge whose accounting/finalisation failed
    // is not "paid and complete", and must never expose another pay action.
    if (!status && json.paymentSucceeded === true) status = 'accounting_pending';
    if (!status) status = 'blocked';

    const result = {
      status,
      provider: verifiedProvider,
      paymentSucceeded: json.paymentSucceeded === true || status === 'paid',
      pending: json.pending === true || ['pending', 'finalizing', 'accounting_pending'].includes(status),
      retryable: typeof json.retryable === 'boolean'
        ? json.retryable
        : (res.ok && ['pending', 'finalizing'].includes(status))
          || (res.ok && status === 'blocked'),
      ...(json.error ? { error: json.error } : {}),
    };
    if (!res.ok && !result.error) result.error = CONFIRM_FALLBACK_ERROR;
    return result;
  } catch {
    return {
      status: 'blocked',
      provider: null,
      paymentSucceeded: false,
      pending: false,
      retryable: true,
      error: CONFIRM_FALLBACK_ERROR,
    };
  }
}
