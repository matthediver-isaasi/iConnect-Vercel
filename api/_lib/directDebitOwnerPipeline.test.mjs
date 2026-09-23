import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { prepareOwnerResume, runScheduledActivation, runOwnerExpiry } from './directDebitOwnerPipeline.js';
import { DryRunEffectBoundary, readonlyTenantDatabase } from './directDebitDryRunRuntime.js';
import { runAnnualOwnerRow } from './annualOwnerRenewalPipeline.js';
import { createMembershipReminders } from './membershipReminders.js';

const now = new Date('2026-06-01T00:00:00Z');
const member = { id: 'member', tenant_id: 'tenant', membership_paused: true,
  membership_pause_restart_date: '2026-05-01', membership_pause_gc_subscriptions: ['SB1'] };
function dbFixture(tables) {
  return { from(table) {
    const filters = [];
    const q = {
      select() { return q; }, order() { return q; }, limit() { return q; },
      eq(k, v) { filters.push(row => row[k] === v); return q; },
      is(k, v) { filters.push(row => v === null ? row[k] == null : row[k] === v); return q; },
      gt(k, v) { filters.push(row => row[k] > v); return q; },
      in(k, v) { filters.push(row => v.includes(row[k])); return q; },
      maybeSingle() { return Promise.resolve({ data: (tables[table] || []).find(row => filters.every(f => f(row))) || null }); },
      single() { return q.maybeSingle(); },
      then(resolve) { resolve({ data: (tables[table] || []).filter(row => filters.every(f => f(row))) }); },
      update() { assert.fail('No database writes permitted'); },
      insert() { assert.fail('No database writes permitted'); },
    };
    return q;
  }, rpc() { assert.fail('No RPC permitted'); } };
}
const recording = operations => ({ async perform(operation) { operations.push(operation); throw new DryRunEffectBoundary(operation); } });

test('shared resume entry produces identical CAS proposal; recording cannot resume subscriptions or make a note', async () => {
  const live = [], preview = [];
  const db = dbFixture({ member: [member] });
  const args = { db, tenantId: 'tenant', memberId: 'member', now, auto: true };
  const result = await prepareOwnerResume({ ...args, effects: { async perform(op) { live.push(op); return { data: [{ id: 'member' }] }; } } });
  assert.deepEqual(result.subscriptionIds, ['SB1']);
  await assert.rejects(prepareOwnerResume({ ...args, db: readonlyTenantDatabase(db, 'tenant'), effects: recording(preview) }), DryRunEffectBoundary);
  assert.deepEqual(preview, live);
  assert.equal(preview[0].payload.values.membership_paused, false);
  assert.match(preview[0].conditional, /compare-and-set/);
});

test('resume is not due or already resumed: no effects', async () => {
  for (const row of [{ ...member, membership_paused: false }, { ...member, membership_pause_restart_date: '2027-01-01' }]) {
    const traces = [];
    await prepareOwnerResume({ db: dbFixture({ member: [row] }), tenantId: 'tenant', memberId: 'member',
      now, auto: true, trace: x => traces.push(x), effects: { perform() { assert.fail('No effect'); } } });
    assert.equal(traces[0].status, 'skipped');
  }
});

test('scheduled member activation shares concrete operation with recording and does not pretend to win CAS', async () => {
  const row = { id: 'history', member_id: 'member', membership_year: '2026', payment_status: 'paid' };
  const args = { row, scope: 'member', tenantId: 'tenant', now };
  const live = [], preview = [];
  const outcome = await runScheduledActivation({ ...args, effects: { async perform(op) { live.push(op); return { data: [] }; } } });
  assert.equal(outcome.raced, true);
  await assert.rejects(runScheduledActivation({ ...args, effects: recording(preview) }), DryRunEffectBoundary);
  assert.deepEqual(preview, live);
  assert.equal(preview[0].payload.values.status, 'active');
});

test('organisation zero-due workflow is a real stop boundary before activation, unpaid member is skipped', async () => {
  const operations = [];
  await assert.rejects(runScheduledActivation({ row: { id: 'h', payment_status: 'paid', total_with_vat: 0 },
    scope: 'organisation', now, tenantId: 'tenant', effects: recording(operations) }), DryRunEffectBoundary);
  assert.deepEqual(operations.map(op => op.type), ['owner.zero_due_workflow']);
  const outcome = await runScheduledActivation({ row: { id: 'h', payment_status: 'unpaid', total_with_vat: 10 },
    scope: 'member', now, tenantId: 'tenant', effects: recording(operations) });
  assert.equal(outcome.skipped, true);
});

test('expiry evaluates only the selected owner and recurring DD history cannot trigger annual access effects', async () => {
  const traces = [];
  const db = dbFixture({ member_membership_history: [
    { id: 'h1', member_id: 'member', tenant_id: 'tenant', billing_period: 'monthly_direct_debit', term_end_date: '2025-01-01' },
    { id: 'h2', member_id: 'other', tenant_id: 'tenant', billing_period: 'annual', term_end_date: '2025-01-01' },
  ] });
  const outcome = await runOwnerExpiry({ db: readonlyTenantDatabase(db, 'tenant'),
    plan: { tenant_id: 'tenant', member_id: 'member' }, agreement: {}, now,
    effects: { perform() { assert.fail('No expiry effect'); } }, trace: x => traces.push(x) });
  assert.equal(outcome.examined, 1);
  assert.equal(traces[0].status, 'skipped');
});

test('real cron and pause paths use the extracted owner entries', async () => {
  const cron = await readFile(new URL('../cron/process-membership-renewals.js', import.meta.url), 'utf8');
  assert.match(cron, /runScheduledActivation\(\{/);
  assert.match(cron, /selectScheduledActivations\(supabase/);
  assert.match(cron, /processTenantAnnualExpirySweep\(db, tenantId/);
  assert.match(cron, /runAnnualOwnerRow\(\{/);
  const pause = await readFile(new URL('./memberPause.js', import.meta.url), 'utf8');
  assert.match(pause, /prepareOwnerResume\(\{/);
});

const simulation = {
  success: true, member: { id: 'member', name: 'Member', email: 'member@example.test' },
  org: { id: 'org', name: 'Organisation' }, config: { id: 'config' }, goLiveDate: '2020-01-01',
  membershipYear: { label: '2026', start: '2026-01-01', end: '2026-12-31' },
  finalCost: 100, totalWithVat: 120, vatAmount: 20, currency: 'GBP', annualCost: 100,
  yearNumber: 6, billingPeriod: 'annual', tierLabel: 'Member',
};
const simulatorFor = sim => ({ simulateMembershipForMember: async () => sim, simulateMembershipForOrg: async () => sim });
test('annual owner creation shares exact history values until insertion result; no hypothetical invoice follows', async () => {
  for (const scope of ['member', 'organisation']) {
    const db = dbFixture({}), live = [], preview = [];
    const args = { db, tenantId: 'tenant', scope, now,
      setting: { member_id: 'member', organization_id: 'org', invoicing_mode: 'automatic' }, simulator: simulatorFor(simulation) };
    await runAnnualOwnerRow({ ...args, effects: { async perform(op) { live.push(op); return { data: { id: 'new-history' } }; } } });
    await assert.rejects(runAnnualOwnerRow({ ...args, db: readonlyTenantDatabase(db, 'tenant'),
      effects: recording(preview) }), DryRunEffectBoundary);
    assert.deepEqual(preview, live);
    assert.equal(preview.length, 1);
    assert.equal(preview[0].type, 'owner.annual_history_insert');
    assert.equal(preview[0].amountMinor, 12000);
    assert.equal(preview[0].payload.values.tenant_id, 'tenant');
  }
});

test('annual existing monthly per-instalment record suppresses invoice; ordinary record constructs invoice', async () => {
  const record = { id: 'history', tenant_id: 'tenant', member_id: 'member', final_cost: 100, total_with_vat: 120,
    currency: 'GBP', membership_year: '2026', billing_agreement_id: 'agreement' };
  const agreement = { id: 'agreement', tenant_id: 'tenant', metadata: { dd: { invoicing_mode: 'per_instalment' } } };
  const db = dbFixture({ member_membership_history: [record], membership_billing_agreements: [agreement] });
  const args = { db, tenantId: 'tenant', scope: 'member', now, setting: { member_id: 'member', invoicing_mode: 'scheduled', invoice_date: '2026-01-01' },
    simulator: simulatorFor({ ...simulation, existingRecord: record }) };
  const skipped = await runAnnualOwnerRow({ ...args, effects: { perform() { assert.fail('No annual double invoice'); } } });
  assert.match(skipped.reason, /per-instalment/);
  agreement.metadata.dd.invoicing_mode = 'annual';
  const operations = [];
  await assert.rejects(runAnnualOwnerRow({ ...args, effects: recording(operations) }), DryRunEffectBoundary);
  assert.equal(operations[0].type, 'owner.annual_invoice');
  assert.equal(operations[0].payload.invoice.finalCost, 100);
});

test('reminder claim records concrete reservation and checks duplicates without mutation', async () => {
  const db = dbFixture({}), live = [], preview = [];
  const identity = { tenant_id: 'tenant', reminder_id: 'reminder', membership_year: '2026', member_id: 'member', scope_type: 'member' };
  await createMembershipReminders({ effects: { async perform(op) { live.push(op); return { data: { id: 'claim' } }; } } }).claimRollingReminder(db, identity, now);
  await assert.rejects(createMembershipReminders({ effects: recording(preview) }).claimRollingReminder(readonlyTenantDatabase(db, 'tenant'), identity, now), DryRunEffectBoundary);
  assert.deepEqual(preview, live);
  const sent = dbFixture({ membership_tier_reminder_send: [{ ...identity, id: 'sent', status: 'sent' }] });
  assert.equal(await createMembershipReminders({ effects: { perform() { assert.fail('No duplicate claim'); } } }).claimRollingReminder(sent, identity, now), null);
});