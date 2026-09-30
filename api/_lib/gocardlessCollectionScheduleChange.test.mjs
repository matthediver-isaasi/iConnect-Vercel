import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { scheduleChangeReason, changeGoCardlessCollectionDay, loadGoCardlessSchedule } from './gocardlessCollectionScheduleChange.js';

const agreement = { id: 'agreement', tenant_id: 'tenant', provider: 'gocardless', status: 'active',
  member_id: 'member', gocardless_mandate_id: 'MD1',
  metadata: { dd: { collection_policy: { version: 1, pricing_policy: 'dynamic' } } } };
const plan = { id: 'plan', tenant_id: 'tenant', billing_agreement_id: 'agreement', member_id: 'member',
  status: 'active', dynamic_next_collection_date: '2027-02-15',
  metadata: { collection_mode: 'dynamic', dynamic_first_date: '2027-01-15' } };
const gc = { getMandate: async () => ({ id: 'MD1', status: 'active', next_possible_charge_date: '2027-02-01' }) };

test('eligibility rejects missing permissions, ownership, paused plans and fixed subscriptions', () => {
  assert.match(scheduleChangeReason({ agreement, plan }), /permissions/);
  for (const patch of [{ tenant_id: 'other' }, { member_id: 'other' }]) {
    assert.match(scheduleChangeReason({ agreement, plan: { ...plan, ...patch }, canEdit: true }), /ownership/);
  }
  assert.match(scheduleChangeReason({ agreement, plan, paused: true, canEdit: true }), /paused/);
  assert.match(scheduleChangeReason({ agreement, plan: { ...plan, status: 'cancelled' }, canEdit: true }), /inactive/);
  assert.match(scheduleChangeReason({ agreement, plan: { ...plan, gocardless_subscription_id: 'SB1' }, canEdit: true }), /replacement/);
  assert.equal(scheduleChangeReason({ agreement, plan, canEdit: true }), null);
});

test('preview uses provider notice evidence and durable SQL preview, no payment mutation', async () => {
  let args;
  const db = { rpc: async (name, values) => {
    assert.equal(name, 'change_gocardless_collection_day');
    args = values;
    return { data: { effective_date: '2027-02-20', version: 2, next_confirmed_date: '2027-01-18' } };
  } };
  const result = await changeGoCardlessCollectionDay({ db, tenantId: 'tenant', agreement, plan, actorEmail: 'admin',
    body: { action: 'preview_collection_day', day: 20 }, gc });
  assert.equal(args.p_confirm, false);
  assert.equal(args.p_notice_date, '2027-02-01');
  assert.equal(result.preview.effectiveDate, '2027-02-20');
  assert.equal(result.preview.nextConfirmedDate, '2027-01-18');
  assert.match(result.preview.message, /Already scheduled payments remain unchanged/);
  assert.match(result.preview.message, /not a confirmed charge/);
  assert.equal(agreement.metadata.dd.collection_day, undefined);
});

test('confirmation trusts persisted preview identity rather than browser dates; errors are surfaced', async () => {
  const requestId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
  let calls = 0;
  const db = { rpc: async (_, values) => {
    calls++;
    assert.equal(values.p_request_id, requestId);
    assert.equal(values.p_confirm, true);
    assert.equal(values.p_effective_date, undefined);
    return { error: { message: 'Schedule changed or preview expired; preview again' } };
  } };
  await assert.rejects(changeGoCardlessCollectionDay({ db, tenantId: 'tenant', agreement, plan, gc,
    body: { action: 'change_collection_day', day: 20, preview: { requestId, effectiveDate: '1900-01-01' } } }), /preview again/);
  assert.equal(calls, 1);
});

test('invalid days and missing confirmations never reach the database or provider', async () => {
  const fail = () => { throw new Error('must not call'); };
  for (const day of [0, 29, 31, 2.5, '15', null]) {
    await assert.rejects(changeGoCardlessCollectionDay({ db: { rpc: fail }, tenantId: 'tenant', agreement, plan,
      gc: { getMandate: fail }, body: { day } }), /1 to 28/);
  }
  await assert.rejects(changeGoCardlessCollectionDay({ tenantId: 'tenant', agreement, plan, body: {
    day: 15, action: 'change_collection_day',
  } }), /saved preview/);
});

test('provider unavailable, wrong mandate and pending mandate cannot amend a schedule', async () => {
  for (const getMandate of [
    async () => { throw new Error('provider unavailable'); },
    async () => ({ id: 'wrong', status: 'active', next_possible_charge_date: '2027-02-01' }),
    async () => ({ id: 'MD1', status: 'pending_submission' }),
  ]) {
    await assert.rejects(changeGoCardlessCollectionDay({ tenantId: 'tenant', agreement, plan,
      body: { day: 15 }, gc: { getMandate }, db: { rpc: () => assert.fail('No write') } }));
  }
});

test('missing and cross-tenant schedules fail closed without provider calls', async () => {
  const result = await loadGoCardlessSchedule({ tenantId: 'other', agreement, plan, canEdit: true,
    gc: { getSubscription: () => assert.fail('No provider read') } });
  assert.equal(result.canEdit, false);
  assert.equal(result.regularDay, null);
  assert.equal(result.evidence, 'unavailable');
});

test('migration fences stale previews, concurrent reservation and ambiguous provider outcomes', () => {
  const sql = readFileSync(new URL('../../supabase/migrations/20261109_manage_monthly_collection_days.sql', import.meta.url), 'utf8');
  assert.match(sql, /tenant_id=p_tenant_id FOR UPDATE/);
  assert.match(sql, /status <> 'submitted'/);
  assert.match(sql, /amendment\.reservation_count <> n/);
  assert.match(sql, /amendment\.version <> v/);
  assert.match(sql, /amendment\.applied_at IS NOT NULL THEN RETURN amendment/);
  assert.match(sql, /greatest\(current_date,p_notice_date/);
  assert.match(sql, /requested_charge_date >= effective/);
  assert.match(sql, /day BETWEEN 1 AND 28/);
  assert.doesNotMatch(sql, /UPDATE public\.membership_billing_agreements/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.change_gocardless_collection_day/);
});