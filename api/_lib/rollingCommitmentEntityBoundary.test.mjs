import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hasGenericCommitmentFields, constrainGenericCommitmentMutation,
} from './rollingCommitmentEntityBoundary.js';

test('generic creation cannot seed commitment fields, including nested bulk payloads', () => {
  for (const table of ['member_membership_history', 'organisation_membership_history', 'membership_billing_agreements']) {
    for (const payload of [
      { term_key: null }, { commitment_snapshot: {} },
      [{ membership_renewal_date: '2027-09-15' }],
      { rows: [{ data: [{ term_duration_months: 12 }] }] },
      { metadata: { card: { commitment: { term_key: 'rolling:2026-09-15' } } } },
    ]) assert.equal(hasGenericCommitmentFields(table, payload), true);
    assert.equal(hasGenericCommitmentFields(table, { notes: 'Legacy correction' }), false);
  }
  assert.equal(hasGenericCommitmentFields('member', { term_key: 'custom value' }), false);
});

test('generic mutation atomically excludes committed rows and leaves other entities alone', () => {
  const predicates = [];
  const query = { is: (...args) => { predicates.push(args); return query; } };
  assert.equal(constrainGenericCommitmentMutation('member_membership_history', query), query);
  assert.deepEqual(predicates, [['term_key', null]]);
  constrainGenericCommitmentMutation('member', query);
  assert.equal(predicates.length, 1);
});