import test from 'node:test';
import assert from 'node:assert/strict';
import { canvasRenewalEligibility } from './canvasRenewalEligibility.js';

const config = { tenant_id: 'tenant', structure_scope_type: 'member', renewal_open_days: 10, renewal_grace_days: 5 };
const record = {
  id: 'term', tenant_id: 'tenant', membership_source: 'personal',
  payment_method: 'card', payment_status: 'paid', billing_period: 'annual',
  status: 'active', term_start_date: '2026-01-01', term_end_date: '2026-12-31',
};
const eligible = (today, patch = {}) => canvasRenewalEligibility({ record, config, today, ...patch }).eligible;
test('fixed annual UTC window includes both exact boundaries and excludes adjacent days', () => {
  for (const [today, expected] of [['2026-12-20', false], ['2026-12-21', true],
    ['2026-12-31', true], ['2027-01-05', true], ['2027-01-06', false]]) {
    assert.equal(eligible(today), expected, today);
  }
});
test('rolling window uses renewal day, not expiry; saved policy wins over live config', () => {
  const rolling = { ...record, term_key: 'rolling', membership_renewal_date: '2027-01-01',
    commitment_snapshot: { payment_frequency: 'upfront', config: { ...config, renewal_open_days: 0, renewal_grace_days: 0 } } };
  for (const [today, expected] of [['2026-12-31', false], ['2027-01-01', true], ['2027-01-02', false]]) {
    assert.equal(eligible(today, { record: rolling }), expected);
  }
});
test('zero means exactly fixed term expiry day; no implicit unrestricted window', () => {
  const zero = { ...config, renewal_open_days: 0, renewal_grace_days: 0 };
  assert.equal(eligible('2026-12-31', { config: zero }), true);
  assert.equal(eligible('2027-01-01', { config: zero }), false);
  assert.equal(eligible('2026-12-30', { config: zero }), false);
});

test('explicit upfront rolling quarterly/monthly terms are not recurring instalments', () => {
  for (const billing_period of ['quarterly', 'monthly']) {
    const rolling = { ...record, billing_period, term_key: 'rolling:2026-12-01',
      membership_renewal_date: '2027-01-01', commitment_snapshot: { payment_frequency: 'upfront', config } };
    assert.equal(eligible('2027-01-01', { record: rolling }), true);
    assert.equal(eligible('2027-01-01', { record: { ...rolling, commitment_snapshot: { payment_frequency: 'monthly', config } } }), false);
  }
});
test('untrusted evidence, recurrence, stopped and successor memberships hide CTA', () => {
  for (const patch of [
    { paused: true }, { hasRecurring: true }, { config: null },
    { config: { ...config, renewal_grace_days: undefined } },
    { config: { ...config, tenant_id: 'other' } },
    ...[{ status: 'cancelled' }, { status: 'paused' }, { status: 'scheduled' },
      { payment_method: 'direct_debit' }, { billing_period: 'monthly' },
      { payment_status: 'unpaid' }, { billing_agreement_id: 'agreement' },
      { membership_source: 'organisation' }, { term_start_date: null },
      { term_end_date: '2026-02-30' }].map(patch => ({ record: { ...record, ...patch } })),
    { history: [{ id: 'next', previous_term_id: 'term', status: 'scheduled' }] },
    { history: [{ ...record, id: 'overlap' }] },
  ]) assert.equal(eligible('2026-12-31', patch), false, JSON.stringify(patch));
});
test('reviewed expiry-only legacy evidence supports grace without fabricated start or renewal', () => {
  const tenant = 'ff2df806-b321-4254-b651-3af11fccf1db';
  const legacy = { id: 'legacy', tenant_id: tenant, membership_source: 'personal',
    membership_year: '2025/2026', status: 'active', payment_status: 'paid',
    payment_method: 'upfront', billing_period: 'annual', currency: 'GBP',
    tier_label: 'Full Membership UK', term_end_date: '2026-10-16',
    notes: JSON.stringify({ source: 'bnms_non_dd_current_backfill' }) };
  const input = { record: legacy, config: { ...config, tenant_id: tenant } };
  const before = JSON.stringify(legacy);
  assert.equal(eligible('2026-10-06', input), true);
  assert.equal(eligible('2026-10-21', input), true);
  assert.equal(eligible('2026-10-22', input), false);
  assert.equal(eligible('2026-10-16', { ...input, record: { ...legacy, notes: null } }), false);
  assert.equal(JSON.stringify(legacy), before);
});