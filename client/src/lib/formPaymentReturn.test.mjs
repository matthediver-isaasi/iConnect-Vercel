// Task #3501: payment return-leg decision logic + wiring contracts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  parsePaymentReturn,
  stripPaymentParams,
  confirmFormPayment,
  CONFIRM_FALLBACK_ERROR,
  SS_KEY,
  paymentContextKey,
  paymentContextScope,
  savePaymentSubmissionContext,
  loadPaymentSubmissionContext,
  clearPaymentSubmissionContext,
} from './formPaymentReturn.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(path.join(here, rel), 'utf8');

// --- parsePaymentReturn -----------------------------------------------------

test('ordinary page load is not a payment return', () => {
  assert.deepEqual(parsePaymentReturn('?slug=my-form'), { kind: 'none' });
  assert.deepEqual(parsePaymentReturn(''), { kind: 'none' });
});

test('GoCardless success return confirms with the submission id', () => {
  const out = parsePaymentReturn('?slug=f&form_payment_submission=sub-1&form_payment_provider=gocardless');
  assert.deepEqual(out, { kind: 'confirm', submissionId: 'sub-1', paymentIntentId: null, provider: 'gocardless' });
});

test('cancelled exit wins over everything else', () => {
  const out = parsePaymentReturn('?form_payment_cancelled=1&form_payment_submission=sub-1');
  assert.deepEqual(out, { kind: 'cancelled' });
});

test('Stripe 3DS success return passes the payment intent through', () => {
  const out = parsePaymentReturn('?form_payment_submission=sub-2&form_payment_provider=stripe&payment_intent=pi_1&redirect_status=succeeded');
  assert.deepEqual(out, { kind: 'confirm', submissionId: 'sub-2', paymentIntentId: 'pi_1', provider: 'stripe' });
});

test('Stripe non-succeeded redirect_status is a failure, not a confirm', () => {
  const out = parsePaymentReturn('?form_payment_submission=sub-2&payment_intent=pi_1&redirect_status=failed');
  assert.deepEqual(out, { kind: 'failed' });
});

test('missing submission param falls back to the sessionStorage backup', () => {
  const out = parsePaymentReturn('?payment_intent=pi_9&redirect_status=succeeded', { storedSubmissionId: 'sub-ss' });
  assert.deepEqual(out, { kind: 'confirm', submissionId: 'sub-ss', paymentIntentId: 'pi_9', provider: null });
});

test('unknown provider is retained only as a neutral return signal', () => {
  const out = parsePaymentReturn('?form_payment_submission=sub-3&form_payment_provider=other');
  assert.deepEqual(out, { kind: 'confirm', submissionId: 'sub-3', paymentIntentId: null, provider: null });
});

test('return params with no recoverable submission id is an orphan (pending copy, not error)', () => {
  const out = parsePaymentReturn('?payment_intent=pi_9&redirect_status=succeeded', { storedSubmissionId: null });
  assert.deepEqual(out, { kind: 'orphan' });
});

// --- stripPaymentParams ------------------------------------------------------

test('strip removes all payment params and keeps the rest', () => {
  const s = '?slug=my-form&form_payment_submission=x&form_payment_provider=gocardless&form_payment_cancelled=1&payment_intent=pi&payment_intent_client_secret=cs&redirect_status=succeeded';
  assert.equal(stripPaymentParams(s), '?slug=my-form');
  assert.equal(stripPaymentParams('?form_payment_submission=x'), '');
});

test('a refresh after cleaning is an ordinary load (round-trip contract)', () => {
  const cleaned = stripPaymentParams('?slug=f&form_payment_submission=x&form_payment_provider=gocardless');
  assert.deepEqual(parsePaymentReturn(cleaned), { kind: 'none' });
});

test('submission context is sanitized path/query-scoped, expiring and contains no payment secret', () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  savePaymentSubmissionContext({
    submissionId: 'sub-safe',
    provider: 'stripe',
    pathname: '/forms/a',
    search: '?slug=alpha&payment_intent=pi_not_stored&payment_intent_client_secret=secret',
    storage,
    now: 100,
  });
  assert.deepEqual(loadPaymentSubmissionContext({
    pathname: '/forms/a',
    search: '?slug=alpha',
    storage,
    now: 200,
  }), { submissionId: 'sub-safe', provider: 'stripe' });
  assert.equal(loadPaymentSubmissionContext({ pathname: '/forms/a', search: '?slug=beta', storage, now: 200 }), null);
  assert.equal(loadPaymentSubmissionContext({ pathname: '/forms/b', search: '?slug=alpha', storage, now: 200 }), null);
  assert.equal(paymentContextScope('/forms/a', '?slug=alpha&redirect_status=succeeded'), '/forms/a?slug=alpha');
  assert.doesNotMatch(values.get(paymentContextKey('/forms/a', '?slug=alpha')), /secret|payment_intent/i);
  assert.equal(loadPaymentSubmissionContext({
    pathname: '/forms/a',
    search: '?slug=alpha',
    storage,
    now: 100 + (24 * 60 * 60 * 1000) + 1,
  }), null);
  clearPaymentSubmissionContext({ pathname: '/forms/a', search: '?slug=alpha', storage });
  assert.equal(values.size, 0);
});

// --- confirmFormPayment -------------------------------------------------------

const mkFetch = (status, body) => async () => ({
  ok: status < 400,
  json: async () => body,
});

test('confirm maps 200 to paid (including alreadyPaid repeats)', async () => {
  const expected = {
    status: 'paid', provider: null, paymentSucceeded: true, pending: false, retryable: false,
  };
  assert.deepEqual(await confirmFormPayment({ submissionId: 's', fetchImpl: mkFetch(200, { success: true }) }), expected);
  assert.deepEqual(await confirmFormPayment({ submissionId: 's', fetchImpl: mkFetch(200, { alreadyPaid: true }) }), expected);
});

test('confirm fails closed on an empty or malformed successful response', async () => {
  const empty = await confirmFormPayment({
    submissionId: 's',
    provider: 'stripe',
    fetchImpl: mkFetch(200, {}),
  });
  assert.deepEqual(empty, {
    status: 'blocked',
    provider: null,
    paymentSucceeded: false,
    pending: false,
    retryable: true,
  });
});

test('confirm maps pending:true to the DD-pending outcome', async () => {
  assert.deepEqual(
    await confirmFormPayment({ submissionId: 's', provider: 'gocardless', fetchImpl: mkFetch(200, { pending: true }) }),
    { status: 'pending', provider: null, paymentSucceeded: false, pending: true, retryable: true },
  );
});

test('confirm maps ambiguous failures to blocked, recheckable no-repay state', async () => {
  const out = await confirmFormPayment({ submissionId: 's', fetchImpl: mkFetch(500, {}) });
  assert.equal(out.status, 'blocked');
  assert.equal(out.retryable, false);
  assert.equal(out.error, CONFIRM_FALLBACK_ERROR);
  const custom = await confirmFormPayment({ submissionId: 's', fetchImpl: mkFetch(400, { error: 'nope' }) });
  assert.equal(custom.status, 'blocked');
  assert.equal(custom.error, 'nope');
  const network = await confirmFormPayment({ submissionId: 's', fetchImpl: async () => { throw new Error('net'); } });
  assert.equal(network.status, 'blocked');
  assert.equal(network.retryable, true);
});

test('confirm preserves verified captured-payment accounting stage as a no-repay state', async () => {
  const out = await confirmFormPayment({
    submissionId: 's',
    fetchImpl: mkFetch(503, {
      paymentSucceeded: true,
      retryable: true,
      error: 'Address update pending',
    }),
  });
  assert.deepEqual(out, {
    status: 'accounting_pending',
    provider: null,
    paymentSucceeded: true,
    pending: true,
    retryable: true,
    error: 'Address update pending',
  });
});

test('confirm preserves every server stage and never promotes setup_complete to paid', async () => {
  for (const status of ['pending', 'finalizing', 'setup_complete', 'paid', 'blocked', 'accounting_pending']) {
    const out = await confirmFormPayment({
      submissionId: 's',
      provider: 'stripe_monthly_card',
      fetchImpl: mkFetch(200, { status, provider: 'stripe_monthly_card', pending: status === 'pending' }),
    });
    assert.equal(out.status, status);
    assert.equal(out.provider, 'stripe_monthly_card');
  }
});

test('client provider hints are neutral until echoed by the verified response', async () => {
  const hinted = await confirmFormPayment({
    submissionId: 's',
    provider: 'gocardless',
    fetchImpl: mkFetch(200, { status: 'pending', pending: true }),
  });
  assert.equal(hinted.provider, null);
  const verified = await confirmFormPayment({
    submissionId: 's',
    provider: 'gocardless',
    fetchImpl: mkFetch(200, { provider: 'stripe', status: 'pending', pending: true }),
  });
  assert.equal(verified.provider, 'stripe');
});

// --- wiring contracts ---------------------------------------------------------

test('both form pages mount the page-level return handler before wizard state', () => {
  for (const page of ['../pages/FormView.jsx', '../pages/EmbedForm.jsx']) {
    const src = read(page);
    assert.match(src, /useFormPaymentReturn\(\)/, `${page} must call useFormPaymentReturn`);
    assert.match(src, /paymentReturn\.active/, `${page} must render the status screen when active`);
    assert.match(src, /<FormPaymentReturnScreen/, `${page} must render FormPaymentReturnScreen`);
    // The status screen must render before loading/access/not-found/submitted
    // branches. A persisted, previously-authorized payment remains safe to
    // confirm even if the public form has since closed or become restricted.
    const returnBranch = src.indexOf('Payment return status always') >= 0
      ? src.indexOf('Payment return status always')
      : src.indexOf('return leg is scoped to an existing');
    assert.ok(
      returnBranch >= 0
        && returnBranch < src.indexOf('if (isLoading)')
        && returnBranch < src.indexOf('if (formAccess.restricted)')
        && returnBranch < src.indexOf('if (submitted)'),
      `${page}: payment return screen must render before the submitted branch`,
    );
    assert.match(
      src,
      /useEffect\(\(\) => \{[\s\S]{0,200}!paymentReturn\.active|if \(paymentReturn\.active \|\|/,
      `${page}: auth redirect effect must not hide an active payment return`,
    );
  }
});

test('FormPaymentSubmit no longer owns the redirect return leg and uses the shared confirm', () => {
  const src = read('../components/forms/FormPaymentSubmit.jsx');
  assert.doesNotMatch(src, /form_payment_cancelled/, 'redirect return-leg parsing must live at page level only');
  assert.doesNotMatch(src, /replaceState/, 'URL cleaning must live at page level only');
  assert.match(src, /confirmFormPayment\(/, 'inline Stripe flow must use the shared confirm helper');
  assert.match(src, /from ["']@\/lib\/formPaymentReturn["']/, 'context/confirm must come from the shared lib');
  assert.doesNotMatch(src, /const SS_KEY =/, 'SS_KEY must not be redefined locally');
  assert.doesNotMatch(src, /sessionStorage\.setItem/, 'submission context must use the path-scoped helper');
});

test('hook cleans the URL and sessionStorage key stays stable', () => {
  const src = read('../components/forms/FormPaymentReturn.jsx');
  assert.match(src, /stripPaymentParams\(/);
  assert.match(src, /history\.replaceState/);
  assert.match(src, /window\.location\.hash/, 'URL cleaning must preserve the #hash (Stripe return_url carries it)');
  assert.equal(SS_KEY, 'form_payment_pending_submission');
  assert.match(src, /PAYMENT_RETURN_POLL_DELAYS_MS = \[1500, 3000, 5000\]/);
  assert.match(src, /button-payment-return-recheck/);
});
