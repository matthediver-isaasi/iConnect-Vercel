import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, legacyExpiry } from './audit-bnms-non-dd-cohort.mjs';

const member = () => ({ preferences: {
  membership_status: 'Active', ym_membership_type: 'Full Membership Overseas',
  member_class: 'Overseas Full', ym_web_site_member_id: '123',
  ym_date_membership_expires: '29/09/2026',
}, history_count: 0, dd_evidence: false, duplicate_fields: false });

test('dates follow retained source formats, reject impossible and missing dates', () => {
  assert.equal(legacyExpiry('29/09/2026'), '2026-09-29');
  assert.equal(legacyExpiry('9/29/26'), '2026-09-29');
  for (const value of ['', '2026-09-29', '31/02/2026', '2/29/26']) assert.equal(legacyExpiry(value), null);
});
test('paid assumption never makes a candidate ready without term and invoice review', () => {
  assert.equal(classify(member()), 'requires_term_and_invoice_review');
});
test('each DD signal excludes even inactive provider records', () => {
  const provider = member(); provider.dd_evidence = true;
  const preference = member(); preference.preferences.direct_debit_payment = 'true';
  const type = member(); type.preferences.ym_membership_type = 'Full Membership DD';
  for (const row of [provider, preference, type]) assert.equal(classify(row), 'direct_debit_excluded');
});
test('existing history, guests and missing evidence remain excluded', () => {
  const prior = member(); prior.history_count = 1;
  assert.equal(classify(prior), 'existing_history_excluded');
  const guest = member(); guest.preferences.ym_membership_type = 'Guest';
  assert.equal(classify(guest), 'outside_membership_cohort');
  const missing = member(); delete missing.preferences.ym_date_membership_expires;
  assert.equal(classify(missing), 'missing_or_invalid_expiry');
  const conflict = member(); conflict.duplicate_fields = true;
  assert.equal(classify(conflict), 'conflicting_preferences');
});