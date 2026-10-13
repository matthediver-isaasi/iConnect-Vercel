import test from 'node:test';
import assert from 'node:assert/strict';
import { annualGraceWarning, recurringGraceWarning, loadMemberGraceWarning } from './memberGraceWarning.js';

test('annual grace uses UTC days and inclusive final day', () => {
  const e = { paidThroughDate: '2026-10-01', graceEndDate: '2026-10-08' };
  assert.equal(annualGraceWarning(e, '2026-10-01'), null);
  assert.equal(annualGraceWarning(e, '2026-10-02').days, 1);
  assert.equal(annualGraceWarning(e, '2026-10-08').expired, false);
  assert.equal(annualGraceWarning(e, '2026-10-09').expired, true);
  assert.equal(annualGraceWarning({}, '2026-10-09'), null);
});
test('DD grace uses saved policy and expires at its timestamp', () => {
  const agreement = { provider: 'gocardless', metadata: { dd: { grace_days: 7 } } };
  const plan = { status: 'payment_grace_period', grace_expires_at: '2026-10-08T12:00:00Z', failed_provider_reference: 'payment' };
  const warning = recurringGraceWarning(plan, agreement, Date.parse('2026-10-04T12:00:00Z'));
  assert.equal(warning.days, 3);
  assert.match(warning.reason, /payment failed/);
  assert.equal(recurringGraceWarning(plan, agreement, Date.parse(plan.grace_expires_at)).expired, true);
  assert.match(recurringGraceWarning({ ...plan, status: 'cancelled' }, agreement, Date.now()).reason, /cancelled/);
  assert.match(recurringGraceWarning({ ...plan, status: 'payment_plan_cancelled' }, agreement, Date.now()).reason, /cancelled/);
  const card = recurringGraceWarning(plan, { provider: 'stripe', metadata: { card: { grace_days: 7 } } }, Date.parse('2026-10-04T12:00:00Z'));
  assert.equal(card.days, 3);
  assert.match(card.reason, /Recurring card/);
  assert.equal(recurringGraceWarning({ ...plan, status: 'active' }, agreement, Date.now()), null);
  assert.equal(recurringGraceWarning({ ...plan, grace_expires_at: null }, agreement, Date.now()), null);
});
test('no warning for paused, missing or already renewed personal membership', async () => {
  const db = { from() { throw new Error('Unexpected database lookup'); } };
  const member = { id: 'member', tenant_id: 'tenant' };
  const base = { member, now: new Date('2026-10-13'), history: [] };
  assert.equal(await loadMemberGraceWarning(db, base), null);
  assert.equal(await loadMemberGraceWarning(db, { ...base, paused: true }), null);
  assert.equal(await loadMemberGraceWarning(db, { ...base, history: [
    { status: 'paid', term_end_date: '2026-10-01' },
    { status: 'paid', term_end_date: '2027-10-01' },
  ] }), null);
});
