import test from 'node:test';
import assert from 'node:assert/strict';
import { shapeCollectionDetails, loadGoCardlessCollectionDetails } from './gocardlessCollectionDetails.js';

const now = new Date('2026-09-18T12:00:00Z');
const agreement = {
  id: 'agreement', tenant_id: 'tenant', status: 'active',
  metadata: { dd: { monthly_amount_minor: 1066, currency: 'GBP',
    collection_policy: { version: 1, end_policy: 'continue', pricing_policy: 'fixed' } } },
};
const plan = { id: 'plan', tenant_id: 'tenant', billing_agreement_id: 'agreement',
  amount_minor: 1066, currency: 'GBP', status: 'active' };
const shape = (extra = {}) => shapeCollectionDetails({ agreement, plan, now, ...extra });

test('proven migrated mandate removes misleading setup blocker without authorising a charge', () => {
  const migratedAgreement = { ...agreement, status: 'mandate_pending', metadata: { dd: {
    ...agreement.metadata.dd, billing_request_mode: 'migration_existing_mandate', activation_rule: 'first_payment',
  } } };
  const migratedPlan = { ...plan, provider: 'gocardless', status: 'mandate_pending', migratedMandateStatus: 'active' };
  const details = shape({ agreement: migratedAgreement, plan: migratedPlan });
  assert.ok(!details.blockers.some(text => /awaiting an active mandate/.test(text)));
  assert.equal(details.upcomingCollection, null);
  assert.equal(details.dueDate, null);
  assert.ok(shape({ agreement: migratedAgreement, plan: { ...migratedPlan, migratedMandateStatus: null } })
    .blockers.some(text => /awaiting an active mandate/.test(text)));
  assert.ok(shape({ agreement: migratedAgreement, plan: { ...migratedPlan, metadata: { bnms_release_required: true } } })
    .blockers.some(text => /held pending reviewed release/.test(text)));
});

test('fixed agreed price is not described as a provider charge', () => {
  const details = shape();
  assert.equal(details.state, 'agreed');
  assert.equal(details.amount, 10.66);
  assert.equal(details.upcomingCollection, null);
  assert.equal(details.dueDate, null);
});

test('upcoming provider amount remains distinct from a reserved calculated price', () => {
  const details = shape({
    payments: [{ status: 'submitted', charge_date: '2026-09-24', amount_minor: 1066, currency: 'GBP' }],
    reservation: { due_date: '2026-10-24', amount_minor: 1200, currency: 'GBP', status: 'reserved' },
  });
  assert.equal(details.state, 'provider_scheduled');
  assert.equal(details.amount, 10.66);
  assert.equal(details.pricePreview.amount, 12);
  assert.equal(details.providerStatus, 'submitted');
});

test('paused plans expose blockers even when a previously submitted payment exists', () => {
  const details = shape({ paused: true, payments: [
    { status: 'submitted', charge_date: '2026-09-24', amount_minor: 1066 },
  ] });
  assert.equal(details.state, 'provider_scheduled');
  assert.deepEqual(details.blockers, ['Membership is paused']);
  assert.equal(shape({ paused: true }).state, 'blocked');
});

test('failed and past pending payments cannot be called upcoming collections', () => {
  const details = shape({ payments: [
    { status: 'failed', charge_date: '2026-09-24', amount_minor: 1066 },
    { status: 'pending_submission', charge_date: '2026-09-10', amount_minor: 1066 },
  ] });
  assert.equal(details.state, 'agreed');
  assert.equal(details.upcomingCollection, null);
});

test('legacy explicit consent is resolved without current structure defaults', () => {
  const saved = { ...agreement, metadata: { dd: { auto_renew: true, monthly_amount_minor: 1066 } } };
  assert.equal(shape({ agreement: saved }).state, 'agreed');
  const ambiguous = { ...agreement, metadata: { dd: { monthly_amount_minor: 1066 } } };
  assert.equal(shape({ agreement: ambiguous }).state, 'blocked');
  assert.match(shape({ agreement: ambiguous }).blockers.join(' '), /needs review/);
});

test('dynamic collection without a provider payment is reserved, not confirmed', () => {
  const saved = { ...agreement, metadata: { dd: {
    collection_policy: { version: 1, end_policy: 'stop', pricing_policy: 'dynamic' },
  } } };
  const details = shape({ agreement: saved, reservation: {
    status: 'reserved', due_date: '2026-10-01', amount_minor: 1250, currency: 'GBP',
  } });
  assert.equal(details.state, 'reserved');
  assert.equal(details.amount, 12.5);
  assert.equal(details.providerStatus, null);
  assert.equal(shape({ agreement: saved }).state, 'unknown');
});

test('read failure and cross-tenant plans fail closed without database fallback', async () => {
  const db = { from() { throw new Error('read unavailable'); } };
  const failed = await loadGoCardlessCollectionDetails({ db, tenantId: 'tenant', agreement, plan, now });
  assert.equal(failed.state, 'blocked');
  assert.equal(failed.amount, null);
  assert.match(failed.blockers.join(' '), /could not be loaded/);
  const wrongTenant = await loadGoCardlessCollectionDetails({
    db, tenantId: 'other', agreement, plan, now,
  });
  assert.equal(wrongTenant.amount, null);
});

test('missing plan while mandate is pending shows no confirmed collections', async () => {
  const result = await loadGoCardlessCollectionDetails({
    db: { from() { throw new Error('unexpected query'); } },
    tenantId: 'tenant', agreement: { ...agreement, status: 'mandate_pending' },
    plan: null, now,
  });
  assert.equal(result.state, 'blocked');
  assert.equal(result.amount, null);
  assert.match(result.blockers.join(' '), /awaiting an active mandate/);
});

test('read model separates a newly calculated active price from a submitted payment', async () => {
  const dynamic = { ...agreement, metadata: { dd: {
    collection_policy: { version: 1, end_policy: 'continue', pricing_policy: 'dynamic' },
  } } };
  const db = { from(table) {
    const result = table === 'gocardless_payments'
      ? { data: [{ amount_minor: 1066, currency: 'GBP', status: 'submitted', charge_date: '2026-09-24' }] }
      : { data: {
        amount_minor: 1066, currency: 'GBP', due_date: '2026-09-24',
        status: 'submitted', gocardless_payment_id: 'payment',
        provider_charge_date: '2026-09-24', provider_evidence: { status: 'submitted' },
      } };
    const chain = {
      select() { return chain; }, order() { return chain; }, limit() { return chain; }, gte() { return chain; },
      eq(column, value) {
        if (column === 'tenant_id') assert.equal(value, 'tenant');
        if (column === 'plan_id') assert.equal(value, 'plan');
        return chain;
      },
      async maybeSingle() { return result; },
      then(resolve, reject) { return Promise.resolve(result).then(resolve, reject); },
    };
    return chain;
  } };
  const details = await loadGoCardlessCollectionDetails({
    db, tenantId: 'tenant', agreement: dynamic, plan, now,
    resolvePrice: async (saved, date) => {
      assert.equal(saved, dynamic);
      assert.equal(date, '2026-09-24');
      return { monthly_amount_minor: 1200, currency: 'GBP' };
    },
  });
  assert.equal(details.state, 'provider_scheduled');
  assert.equal(details.amount, 10.66);
  assert.equal(details.pricePreview.amount, 12);
  assert.match(details.blockers.join(' '), /will not be repriced/);
  const unavailable = await loadGoCardlessCollectionDetails({
    db, tenantId: 'tenant', agreement: dynamic, plan, now,
    resolvePrice: async () => { throw new Error('ambiguous'); },
  });
  assert.equal(unavailable.amount, 10.66);
  assert.equal(unavailable.pricePreview, null);
  assert.match(unavailable.blockers.join(' '), /unambiguously/);
});