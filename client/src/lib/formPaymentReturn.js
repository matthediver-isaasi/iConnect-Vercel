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

function normalizeRelativePath(value) {
  if (typeof value !== 'string' || value.length > 8192
      || !value.startsWith('/') || value.startsWith('//')
      || /[\\\u0000-\u0020\u007f]|%(?:0[0-9a-f]|1[0-9a-f]|5c|7f)/i.test(value)) return null;
  try {
    const url = new URL(value, 'https://payment-return.invalid');
    if (url.origin !== 'https://payment-return.invalid'
        || /%(?:2f|5c)/i.test(url.pathname)) return null;
    // Encoded slashes in query values are ordinary data (e.g. next=%2Fhome),
    // not path separators. Serialize them identically before saving/relaying.
    return `${url.pathname}${stripPaymentParams(url.search)}`;
  } catch {
    return null;
  }
}

function safeRelativePath(pathname, search = '') {
  return normalizeRelativePath(`${pathname}${search}`) || '/';
}

/** Safe non-payment continuation paths are local and never another form. */
export function sanitizePaymentContinuePath(value) {
  const path = normalizeRelativePath(value);
  if (!path) return '/';
  return /^\/(?:embed\/form|forms)(?:\/|$|\?)/i.test(path) ? '/' : path;
}

/**
 * Resolve where a payment provider may return and which browsing context may
 * be navigated to it. A framed form is allowed to use its containing page
 * only when it can read that page and prove it is the same origin. Cross-origin
 * embeds deliberately remain in their own frame: they must never navigate an
 * arbitrary host page.
 */
export function getPaymentNavigationContext(windowObj = typeof window !== 'undefined' ? window : null) {
  if (!windowObj?.location) {
    return { returnPath: '/', target: 'self', framed: false };
  }
  const ownPath = safeRelativePath(windowObj.location.pathname, windowObj.location.search);
  try {
    if (windowObj.self === windowObj.top) {
      return { returnPath: ownPath, target: 'self', framed: false };
    }
    const topLocation = windowObj.top.location;
    if (topLocation.origin !== windowObj.location.origin) {
      return { returnPath: ownPath, target: 'self', framed: true };
    }
    return {
      returnPath: safeRelativePath(topLocation.pathname, topLocation.search),
      target: 'top',
      framed: true,
    };
  } catch {
    // Accessing a cross-origin ancestor throws. Treat it as an external embed,
    // not as permission to navigate the top-level page.
    return { returnPath: ownPath, target: 'self', framed: true };
  }
}

/** Navigate to a provider only in the browsing context established above. */
export function navigateToPaymentProvider(url, navigation, windowObj = typeof window !== 'undefined' ? window : null) {
  if (!windowObj || !url) return false;
  if (navigation?.target === 'top') {
    try {
      // This was selected only after a same-origin read in
      // getPaymentNavigationContext. Do not fall through to top on failure.
      if (windowObj.top.location.origin === windowObj.location.origin) {
        windowObj.top.location.assign(url);
        return true;
      }
    } catch { /* do not fall through to an iframe after losing top access */ }
    return false;
  }
  windowObj.location.assign(url);
  return true;
}

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
  returnPath = null,
  continuePath = null,
  terminalStatus = null,
  pathname = typeof window !== 'undefined' ? window.location.pathname : '/',
  search = typeof window !== 'undefined' ? window.location.search : '',
  storage = typeof sessionStorage !== 'undefined' ? sessionStorage : null,
  now = Date.now(),
}) {
  if (!submissionId || !storage) return;
  const scope = paymentContextScope(pathname, search);
  const normalizedReturnPath = normalizeRelativePath(returnPath);
  const normalizedContinuePath = sanitizePaymentContinuePath(continuePath);
  const context = {
    submissionId,
    provider: VERIFIED_PAYMENT_PROVIDERS.has(provider) ? provider : null,
    scope,
    createdAt: now,
    // This is a same-origin relative page path selected before leaving for a
    // provider. It lets a Canvas parent relay a return only back to the exact
    // form frame that created this submission; it is not an arbitrary URL.
    ...(normalizedReturnPath ? { returnPath: normalizedReturnPath } : {}),
    ...(continuePath && normalizedContinuePath ? { continuePath: normalizedContinuePath } : {}),
    ...(terminalStatus === 'paid' ? { terminalStatus: 'paid' } : {}),
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
      ...(normalizeRelativePath(parsed.returnPath)
        ? { returnPath: normalizeRelativePath(parsed.returnPath) }
        : {}),
      ...(parsed.continuePath ? { continuePath: sanitizePaymentContinuePath(parsed.continuePath) } : {}),
      ...(parsed.terminalStatus === 'paid' ? { terminalStatus: 'paid' } : {}),
    };
  } catch {
    // A bare id is accepted only to finish an old redirect. It is deliberately
    // not used for refresh resume because the legacy value was not path-bound.
    return { submissionId: legacy, provider: null, legacy: true };
  }
}

/**
 * Return the provider parameters a same-origin Canvas parent may pass into one
 * specific iframe. The saved context is both short-lived and bound to the
 * iframe's path/query and the exact containing page path. A query pasted onto
 * another Canvas page, another form embed, or another submission is ignored.
 */
export function getEmbeddedPaymentReturnRelay({
  parentPathname,
  parentSearch,
  iframePathname,
  iframeSearch = '',
  storage = typeof sessionStorage !== 'undefined' ? sessionStorage : null,
  now = Date.now(),
} = {}) {
  const context = loadPaymentSubmissionContext({
    pathname: iframePathname,
    search: iframeSearch,
    storage,
    now,
  });
  if (!context?.returnPath) return null;
  const parentPath = safeRelativePath(parentPathname, parentSearch);
  if (context.returnPath !== parentPath) return null;
  const returnedSubmissionId = new URLSearchParams(parentSearch || '').get('form_payment_submission');
  // Every relay outcome, including provider cancellation/failure, has to name
  // the exact submission that this iframe created. A context alone cannot
  // select a form instance when a page contains multiple embeds.
  if (!returnedSubmissionId || returnedSubmissionId !== context.submissionId) return null;
  const decision = parsePaymentReturn(parentSearch, {
    storedSubmissionId: context.submissionId,
  });
  if (decision.kind === 'none' || decision.kind === 'orphan') return null;

  const source = new URLSearchParams(parentSearch || '');
  const params = new URLSearchParams();
  PAYMENT_RETURN_PARAMS.forEach((key) => {
    if (source.has(key)) params.set(key, source.get(key));
  });
  return params.toString() ? `?${params.toString()}` : null;
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
