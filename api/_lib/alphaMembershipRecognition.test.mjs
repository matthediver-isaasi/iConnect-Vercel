import test from 'node:test';
import assert from 'node:assert/strict';
import { ALPHA_RECOGNITION_TENANT as tenant, attachAlphaMembershipRecognition, currentMembershipRecognition } from './alphaMembershipRecognition.js';
import { buildCanvasSummary, selectCanvasCommitment } from '../membership/canvas-summary.js';
import { shapePersistedCommitment } from '../membership/member-membership.js';
const recognition = () => ({
  tenant_id: tenant, member_id: 'member', history_id: 'history', agreement_id: 'agreement',
  effective_from: '2026-09-21', effective_until: '2027-10-01', revoked_at: null,
});
const record = () => ({
  id: 'history', tenant_id: tenant, member_id: 'member', billing_agreement_id: 'agreement',
  membership_source: 'personal', term_key: 'rolling:2026-10-01',
  term_start_date: '2026-10-01', term_end_date: '2027-09-30', membership_renewal_date: '2027-10-01',
  status: 'pending_payment_setup', payment_status: 'unpaid', payment_method: 'direct_debit',
  membershipRecognition: recognition(),
});
test('current recognition is bounded, owner-bound, revocable and never masks termination', () => {
  assert.ok(currentMembershipRecognition(record(), '2026-09-21'));
  assert.ok(currentMembershipRecognition(record(), '2027-09-30'));
  for (const day of ['2026-09-20', '2027-10-01']) assert.equal(currentMembershipRecognition(record(), day), null);
  for (const patch of [{ member_id: 'other' }, { tenant_id: 'other' }, { history_id: 'other' },
    { agreement_id: 'other' }, { revoked_at: '2026-09-22' }, { effective_until: '2099-01-01' }]) {
    assert.equal(currentMembershipRecognition({ ...record(), membershipRecognition: { ...recognition(), ...patch } }, '2026-09-21'), null);
  }
  for (const status of ['expired', 'cancelled', 'paused', 'failed', 'activation_failed']) {
    assert.equal(currentMembershipRecognition({ ...record(), status }, '2026-09-21'), null);
  }
  assert.equal(currentMembershipRecognition({ ...record(), membership_source: 'organisation' }, '2026-09-21'), null);
});
test('recognition makes membership current while preserving every financial and contract field', () => {
  const h = record(), before = structuredClone(h), today = '2026-09-21';
  const plan = { provider: 'gocardless', status: 'first_payment_pending', collection_stopped_at: '2026-09-20T00:00:00Z',
    membership_billing_agreements: { status: 'first_payment_pending' } };
  const summary = buildCanvasSummary({ selected: selectCanvasCommitment([h], [], today), plan, today });
  assert.equal(summary.membership.state, 'active');
  assert.equal(summary.membership.memberSince, null, 'recognition must not invent joining history');
  assert.equal(summary.payment.state, 'paused');
  assert.equal(summary.payment.nextPayment, null);
  assert.equal(summary.payment.confirmedPayment, null);
  assert.equal(summary.membership.renewalDate, '2027-10-01');
  const commitment = shapePersistedCommitment(h, new Date(today));
  assert.equal(commitment.lifecycle, 'scheduled', 'billing commitment remains scheduled');
  assert.ok(commitment.membershipRecognition);
  assert.equal(commitment.startDate, '2026-10-01');
  assert.deepEqual(h, before);
  const unrecognised = { ...h, membershipRecognition: undefined };
  assert.equal(buildCanvasSummary({ selected: selectCanvasCommitment([unrecognised], [], today), plan, today }).membership.state, 'pending');
  assert.equal(buildCanvasSummary({ selected: selectCanvasCommitment([h], [], today), plan, paused: true, today }).membership.state, 'paused');
});
function db(data, error) {
  const filters = [];
  const query = { select() { return this; }, eq(key, value) { filters.push([key, value]); return this; },
    then(resolve) { return Promise.resolve({ data, error }).then(resolve); } };
  return { filters, from(name) { assert.equal(name, 'bnms_dd_alpha_membership_recognition'); return query; } };
}
test('recognition reader scopes tenant/member and fails closed across owner, schema and read errors', async () => {
  const h = { ...record(), membershipRecognition: undefined };
  const database = db([recognition()]);
  await attachAlphaMembershipRecognition(database, tenant, 'member', [h], '2026-09-21');
  assert.ok(h.membershipRecognition);
  assert.deepEqual(database.filters, [['tenant_id', tenant], ['member_id', 'member']]);
  await assert.rejects(attachAlphaMembershipRecognition(db([{ ...recognition(), member_id: 'other' }]), tenant, 'member', [h]), /ownership/);
  for (const code of ['42P01', 'PGRST205']) {
    const row = { ...record(), membershipRecognition: undefined };
    await attachAlphaMembershipRecognition(db(null, { code }), tenant, 'member', [row]);
    assert.equal(row.membershipRecognition, undefined);
  }
  for (const code of ['42703', '42501', '57014']) {
    await assert.rejects(attachAlphaMembershipRecognition(db(null, { code }), tenant, 'member', [h]), /Unable to load/);
  }
  await attachAlphaMembershipRecognition({ from() { assert.fail('Non-alpha tenant must not be read'); } }, 'other', 'member', [h]);
});