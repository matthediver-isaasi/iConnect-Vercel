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
  assert.deepEqual(out, { kind: 'confirm', submissionId: 'sub-1', paymentIntentId: null });
});

test('cancelled exit wins over everything else', () => {
  const out = parsePaymentReturn('?form_payment_cancelled=1&form_payment_submission=sub-1');
  assert.deepEqual(out, { kind: 'cancelled' });
});

test('Stripe 3DS success return passes the payment intent through', () => {
  const out = parsePaymentReturn('?form_payment_submission=sub-2&form_payment_provider=stripe&payment_intent=pi_1&redirect_status=succeeded');
  assert.deepEqual(out, { kind: 'confirm', submissionId: 'sub-2', paymentIntentId: 'pi_1' });
});

test('Stripe non-succeeded redirect_status is a failure, not a confirm', () => {
  const out = parsePaymentReturn('?form_payment_submission=sub-2&payment_intent=pi_1&redirect_status=failed');
  assert.deepEqual(out, { kind: 'failed' });
});

test('missing submission param falls back to the sessionStorage backup', () => {
  const out = parsePaymentReturn('?payment_intent=pi_9&redirect_status=succeeded', { storedSubmissionId: 'sub-ss' });
  assert.deepEqual(out, { kind: 'confirm', submissionId: 'sub-ss', paymentIntentId: 'pi_9' });
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

// --- confirmFormPayment -------------------------------------------------------

const mkFetch = (status, body) => async () => ({
  ok: status < 400,
  json: async () => body,
});

test('confirm maps 200 to paid (including alreadyPaid repeats)', async () => {
  globalThis.sessionStorage = { removeItem() {} };
  assert.deepEqual(await confirmFormPayment({ submissionId: 's', fetchImpl: mkFetch(200, {}) }), { status: 'paid' });
  assert.deepEqual(await confirmFormPayment({ submissionId: 's', fetchImpl: mkFetch(200, { alreadyPaid: true }) }), { status: 'paid' });
});

test('confirm maps pending:true to the DD-pending outcome', async () => {
  assert.deepEqual(await confirmFormPayment({ submissionId: 's', fetchImpl: mkFetch(200, { pending: true }) }), { status: 'pending' });
});

test('confirm maps failures to the do-not-pay-again error', async () => {
  const out = await confirmFormPayment({ submissionId: 's', fetchImpl: mkFetch(500, {}) });
  assert.equal(out.status, 'error');
  assert.equal(out.error, CONFIRM_FALLBACK_ERROR);
  const custom = await confirmFormPayment({ submissionId: 's', fetchImpl: mkFetch(400, { error: 'nope' }) });
  assert.deepEqual(custom, { status: 'error', error: 'nope' });
  const network = await confirmFormPayment({ submissionId: 's', fetchImpl: async () => { throw new Error('net'); } });
  assert.equal(network.status, 'error');
});

// --- wiring contracts ---------------------------------------------------------

test('both form pages mount the page-level return handler before wizard state', () => {
  for (const page of ['../pages/FormView.jsx', '../pages/EmbedForm.jsx']) {
    const src = read(page);
    assert.match(src, /useFormPaymentReturn\(\)/, `${page} must call useFormPaymentReturn`);
    assert.match(src, /paymentReturn\.active/, `${page} must render the status screen when active`);
    assert.match(src, /<FormPaymentReturnScreen/, `${page} must render FormPaymentReturnScreen`);
    // The status screen must render BEFORE the submitted branch so an
    // already-finalized submission still shows the paid outcome.
    assert.ok(
      src.indexOf('paymentReturn.active') < src.indexOf('if (submitted)'),
      `${page}: payment return screen must render before the submitted branch`,
    );
  }
});

test('FormPaymentSubmit no longer owns the redirect return leg and uses the shared confirm', () => {
  const src = read('../components/forms/FormPaymentSubmit.jsx');
  assert.doesNotMatch(src, /form_payment_cancelled/, 'redirect return-leg parsing must live at page level only');
  assert.doesNotMatch(src, /replaceState/, 'URL cleaning must live at page level only');
  assert.match(src, /confirmFormPayment\(/, 'inline Stripe flow must use the shared confirm helper');
  assert.match(src, /from ["']@\/lib\/formPaymentReturn["']/, 'SS_KEY/confirm must come from the shared lib');
  assert.doesNotMatch(src, /const SS_KEY =/, 'SS_KEY must not be redefined locally');
});

test('hook cleans the URL and sessionStorage key stays stable', () => {
  const src = read('../components/forms/FormPaymentReturn.jsx');
  assert.match(src, /stripPaymentParams\(/);
  assert.match(src, /history\.replaceState/);
  assert.match(src, /window\.location\.hash/, 'URL cleaning must preserve the #hash (Stripe return_url carries it)');
  assert.equal(SS_KEY, 'form_payment_pending_submission');
});
