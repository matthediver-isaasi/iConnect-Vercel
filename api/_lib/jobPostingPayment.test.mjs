import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_JOB_POSTING_PRICE,
  resolveConfiguredJobPostingPrice,
  resolveStoredJobPostingAmount,
} from './jobPostingPayment.js';

test('blank, invalid, and zero configured prices use the intentional default', () => {
  for (const value of [null, undefined, '', '   ', 'not-a-price', '0', 0, '-5']) {
    assert.equal(resolveConfiguredJobPostingPrice(value), DEFAULT_JOB_POSTING_PRICE);
  }
  assert.equal(resolveConfiguredJobPostingPrice('75.50'), 75.5);
});

test('payment amount comes from the stored pending posting amount', () => {
  assert.equal(resolveStoredJobPostingAmount({ amount_paid: '75.50' }), 75.5);
});

test('missing or invalid stored payment amounts are rejected', () => {
  assert.throws(
    () => resolveStoredJobPostingAmount({ amount_paid: null }),
    /payment amount is not configured/,
  );
  assert.throws(
    () => resolveStoredJobPostingAmount({}),
    /payment amount is not configured/,
  );
  assert.throws(
    () => resolveStoredJobPostingAmount({ amount_paid: -1 }),
    /payment amount is not configured/,
  );
  assert.throws(
    () => resolveStoredJobPostingAmount({ amount_paid: 0 }),
    /payment amount is not configured/,
  );
});

test('PaymentIntent creation ignores browser amounts and tenant-scopes the pending posting', () => {
  const source = readFileSync(
    new URL('../functions/[functionName].js', import.meta.url),
    'utf8',
  );
  const handlerSource = source.slice(
    source.indexOf('async createJobPostingPaymentIntent'),
    source.indexOf('async setPublicHomePage'),
  );

  assert.match(handlerSource, /resolveStoredJobPostingAmount\(jobPosting\)/);
  assert.match(handlerSource, /\.eq\('tenant_id', tenantId\)/);
  assert.match(handlerSource, /\.eq\('status', 'pending_payment'\)/);
  assert.match(handlerSource, /currency: 'gbp'/);
  assert.match(handlerSource, /idempotencyKey: `job-posting:/);
  assert.match(handlerSource, /stripe_payment_intent_id/);
  assert.doesNotMatch(handlerSource, /const \{ amount/);
  assert.doesNotMatch(handlerSource, /params\.amount/);
});

test('payment confirmation requires the stored intent and a conditional pending-state transition', () => {
  const source = readFileSync(
    new URL('../functions/[functionName].js', import.meta.url),
    'utf8',
  );
  const handlerSource = source.slice(
    source.indexOf('async confirmJobPostingPayment'),
    source.indexOf('async cancelProgramTicketTransaction'),
  );

  assert.match(handlerSource, /if \(!metadataMatch \|\| !storedMatch\)/);
  assert.match(handlerSource, /\.eq\('tenant_id', tenantId\)/);
  assert.match(handlerSource, /\.eq\('status', 'pending_payment'\)/);
  assert.match(handlerSource, /\.eq\('stripe_payment_intent_id', paymentIntentId\)/);
});

test('public settings expose only the new price key through the existing tenant-scoped endpoint', () => {
  const source = readFileSync(
    new URL('../public/system-settings.js', import.meta.url),
    'utf8',
  );

  assert.match(source, /'job_types'/);
  assert.match(source, /'job_hours'/);
  assert.match(source, /'job_posting_price'/);
  assert.match(source, /\.eq\('tenant_id', tenant\.id\)/);
  assert.match(source, /PUBLIC_SETTINGS_WHITELIST\.includes\(key\)/);
});