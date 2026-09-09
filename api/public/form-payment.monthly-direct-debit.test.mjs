import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  buildAgreementSnapshot,
  monthlyBillingRequestFingerprint,
} from '../_lib/gocardlessDirectDebit.js';

function snapshotFor(quote, offer) {
  return buildAgreementSnapshot({
    offer,
    simResult: {
      membershipYear: {
        label: quote.membership_year,
        start: quote.membership_year_start,
      },
      config: { id: quote.config_id },
      matchedBand: quote.band_id ? { id: quote.band_id } : null,
      tierLabel: quote.tier_label,
      fieldValue: quote.field_value,
      annualCost: quote.annual_cost,
      finalCost: quote.final_cost,
    },
    includeBillingRequestPayment: false,
    billingRequestMode: 'mandate_only',
  });
}

const baseOffer = {
  monthlyAmount: 10,
  monthlyAmountMinor: 1000,
  instalmentCount: 12,
  planTotal: 120,
  currency: 'GBP',
  firstCollectionRule: 'earliest',
  collectionDay: null,
  activationRule: 'mandate',
  autoRenew: false,
  graceDays: 0,
  termsVersion: 1,
};

test('flat public membership DD snapshot uses configured monthly terms', () => {
  const snapshot = snapshotFor({
    membership_year: '2026/27',
    membership_year_start: '2026-10-01',
    config_id: 'config-flat',
    annual_cost: 120,
    final_cost: 120,
  }, baseOffer);
  assert.equal(snapshot.monthly_amount_minor, 1000);
  assert.equal(snapshot.instalment_count, 12);
  assert.equal(snapshot.plan_total, 120);
  assert.equal(snapshot.billing_request_mode, 'mandate_only');
  assert.equal(snapshot.billing_request_payment, undefined);
});

test('banded and prorated annual totals never change the saved monthly DD amount', () => {
  const banded = snapshotFor({
    membership_year: '2026/27',
    membership_year_start: '2026-10-01',
    config_id: 'config-tiered',
    band_id: 'band-junior',
    annual_cost: 300,
    final_cost: 47.5,
  }, {
    ...baseOffer,
    monthlyAmount: 20,
    monthlyAmountMinor: 2000,
    instalmentCount: 6,
    planTotal: 120,
  });
  assert.equal(banded.monthly_amount_minor, 2000);
  assert.equal(banded.instalment_count, 6);
  assert.equal(banded.plan_total, 120);
  assert.equal(banded.final_cost, 47.5);
});

test('monthly DD idempotency follows saved collection terms, not annual totals', () => {
  const left = snapshotFor({
    membership_year: '2026/27',
    config_id: 'config-flat',
    annual_cost: 120,
    final_cost: 50,
  }, baseOffer);
  const right = snapshotFor({
    membership_year: '2026/27',
    config_id: 'config-flat',
    annual_cost: 120,
    final_cost: 99,
  }, baseOffer);
  assert.equal(
    monthlyBillingRequestFingerprint(left),
    monthlyBillingRequestFingerprint(right),
  );
});

test('public route keeps monthly mandate-only and generic one-off GoCardless branches distinct', async () => {
  const source = await readFile(new URL('./form-payment.js', import.meta.url), 'utf8');
  const monthlyStart = source.indexOf('async function handleCreateMonthlyDirectDebit');
  const confirmStart = source.indexOf('async function handleConfirm', monthlyStart);
  const monthly = source.slice(monthlyStart, confirmStart);
  const genericStart = source.indexOf('// GoCardless: billing request (mandate + one-off payment)');
  const generic = source.slice(genericStart, monthlyStart);

  assert.match(monthly, /buildAgreementSnapshot/);
  assert.match(monthly, /billingRequestMode: 'mandate_only'/);
  assert.match(monthly, /buildMonthlyBillingRequest/);
  assert.match(monthly, /type:\s*'form_monthly_direct_debit'/);
  assert.match(monthly, /agreement_id:\s*String\(agreement\.id\)/);
  assert.match(monthly, /form_submission_id:\s*String\(submissionRow\.id\)/);
  const providerMetadata = monthly.slice(
    monthly.indexOf("type: 'form_monthly_direct_debit'"),
    monthly.indexOf('}),', monthly.indexOf("type: 'form_monthly_direct_debit'")),
  );
  assert.doesNotMatch(providerMetadata, /\b(?:kind|tenant_id|membership_year)\s*:/);
  assert.match(monthly, /classifyMonthlyConsentAgreement/);
  assert.match(monthly, /rotateStaleMonthlyConsentAgreement/);
  assert.ok(
    monthly.indexOf('if (consent.rotatable)') < monthly.indexOf('savedFingerprint !== currentFingerprint'),
    'legacy stale consent must rotate before mandate-only fingerprint comparison',
  );
  assert.doesNotMatch(monthly, /paymentAmountMinor:/);

  assert.match(generic, /paymentAmountMinor: amountMinor/);
  assert.match(generic, /type: 'form_payment'/);
  assert.match(source, /payment_provider === 'gocardless_monthly_dd'/);
  assert.match(source, /processGocardlessEvent/);
});

test('reconciliation recovers unlinked monthly-DD requests and setup-complete failures', async () => {
  const source = await readFile(
    new URL('../_lib/formPaymentReconciliation.js', import.meta.url),
    'utf8',
  );
  assert.match(
    source,
    /payment_reference\.not\.is\.null,payment_provider\.eq\.gocardless_monthly_dd/,
  );
  assert.match(source, /persistMonthlyDirectDebitLink/);
  assert.match(source, /\.in\('payment_status', \['pending', 'setup_complete'\]\)/);
  assert.match(source, /payment_meta->monthly_dd_state/);
});