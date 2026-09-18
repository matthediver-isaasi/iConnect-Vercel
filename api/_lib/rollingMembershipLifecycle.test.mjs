import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildRollingTerm } from '../../shared/rollingMembershipTerm.js';
import { annualRecordSchedule, classifyAnnualRenewal, deriveAnnualTerm, isAnnualNonRecurring } from './annualRenewalPolicy.js';
import { upfrontRollingCommitment } from './upfrontRollingRenewal.js';
import { rollingMembershipWindow, calculateNextMembershipYearWindow } from './membershipYear.js';

let temporaryRoot;
let resolveRollingSimulationContext;
let rollingReminderCandidates;
let claimRollingReminder;
let rollingReminderSendDate;
let isCurrentMembershipProtection;
let hasSuccessfulNextTerm;
before(async () => {
  temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'rolling-lifecycle-'));
  const lib = path.join(temporaryRoot, 'api', '_lib');
  await mkdir(lib, { recursive: true });
  await mkdir(path.join(temporaryRoot, 'shared'));
  await writeFile(path.join(temporaryRoot, 'package.json'), '{"type":"module"}');
  await cp(new URL('../../shared/rollingMembershipTerm.js', import.meta.url), path.join(temporaryRoot, 'shared', 'rollingMembershipTerm.js'));
  for (const file of ['membershipSimulation.js', 'membershipConfigResolver.js', 'membershipYear.js', 'membershipReminders.js', 'membershipRenewalBudget.js', 'annualRenewalPolicy.js', 'annualMembershipExpiryEnforcement.js']) {
    await cp(new URL(file, import.meta.url), path.join(lib, file));
  }
  const stubs = {
    'database.js': 'export const supabase = {from(){throw new Error("Live database forbidden in lifecycle tests")}};',
    'discountHelper.js': 'export const evaluateDiscountsForOrg = null; export const applyDiscountsToAnnualCost = null;',
    'vatOverrideHelper.js': 'export const evaluateVatOverrideForOrg = null; export const evaluateVatOverrideForMember = null;',
    'invoiceAddressResolver.js': 'export const resolveInvoiceAddress = null;',
    'tierBandMatcher.js': 'export const matchBand = null;',
    'tenantEmailService.js': 'export const sendTenantEmail = () => { throw new Error("Email forbidden in lifecycle tests"); };',
    'emailService.js': 'export const replacePlaceholders = null;',
    'transactionalInbox.js': 'export const buildInboxDelivery = null; export const recordTransactionalInboxMessage = null; export const resolveCommunicationCategoryIdForLabel = null;',
    'memberPause.js': 'export const getPausedMemberIdSet = null;',
    'session.js': 'export const invalidateMemberSessions = () => { throw new Error("Session effects forbidden in lifecycle tests"); };',
  };
  for (const [file, content] of Object.entries(stubs)) await writeFile(path.join(lib, file), content);
  ({ resolveRollingSimulationContext } = await import(pathToFileURL(path.join(lib, 'membershipSimulation.js'))));
  ({ rollingReminderCandidates, claimRollingReminder, rollingReminderSendDate } = await import(pathToFileURL(path.join(lib, 'membershipReminders.js'))));
  ({ isCurrentMembershipProtection, hasSuccessfulNextTerm } = await import(pathToFileURL(path.join(lib, 'annualMembershipExpiryEnforcement.js'))));
});
after(async () => { await rm(temporaryRoot, { recursive: true, force: true }); });

const oldConfig = { id: 'old', tenant_id: 'tenant', start_mode: 'immediate', structure_scope_type: 'member', billing_period: 'annual', flat_cost: 240, renewal_open_days: 30, renewal_grace_days: 7 };
function term(start = '2026-09-15', period = 'annual', extra = {}) {
  return {
    ...buildRollingTerm({ startDate: start, billingPeriod: period }), id: 'prior', tenant_id: 'tenant', member_id: 'member',
    config_id: 'old', billing_period: period, payment_status: 'paid', status: 'active',
    final_cost: 240, total_with_vat: 240, currency: 'GBP',
    commitment_snapshot: { start_mode: 'immediate', payment_frequency: 'upfront', billing_period: period, config: { ...oldConfig, billing_period: period } },
    ...extra,
  };
}
function client(tables) {
  return { from(table) {
    const filters = [];
    let write = null;
    return {
      select() { return this; }, limit() { return this; },
      eq(key, value) { filters.push(row => row[key] === value); return this; },
      neq(key, value) { filters.push(row => row[key] !== value); return this; },
      gte(key, value) { filters.push(row => row[key] >= value); return this; },
      in(key, values) { filters.push(row => values.includes(row[key])); return this; },
      or(expression) {
        const comparison = expression.split(',')[1].split('.');
        filters.push(row => row[comparison[0]] == null || (comparison[1] === 'lte' ? row[comparison[0]] <= comparison[2] : row[comparison[0]] >= comparison[2]));
        return this;
      },
      insert(value) { write = { insert: value }; return this; },
      update(value) { write = { update: value }; return this; },
      run(single) {
        const rows = tables[table] ||= [];
        if (write?.insert) {
          const row = write.insert;
          if (rows.some(existing => ['reminder_id', 'membership_year', 'member_id', 'organization_id'].every(key => existing[key] === row[key]))) return { error: { code: '23505' } };
          const inserted = { id: `delivery-${rows.length}`, ...row };
          rows.push(inserted);
          return { data: single ? inserted : [inserted], error: null };
        }
        const matches = rows.filter(row => filters.every(predicate => predicate(row)));
        if (write?.update) matches.forEach(row => Object.assign(row, write.update));
        return { data: single ? matches[0] || null : matches, error: null };
      },
      maybeSingle() { return Promise.resolve(this.run(true)); },
      then(resolve, reject) { return Promise.resolve(this.run(false)).then(resolve, reject); },
    };
  } };
}

test('calendar windows have term-specific identity and preserve month-end anchors', () => {
  const monthly = rollingMembershipWindow({ billing_period: 'monthly' }, '2028-01-31');
  assert.equal(monthly.membership_renewal_date, '2028-02-29');
  const next = rollingMembershipWindow({ billing_period: 'monthly' }, monthly.membership_renewal_date, monthly);
  assert.equal(next.membership_renewal_date, '2028-03-31');
  assert.notEqual(next.label, monthly.label);
  assert.equal(calculateNextMembershipYearWindow({ start_mode: 'immediate', billing_period: 'quarterly' }, new Date('2026-09-15')).label, 'rolling:2026-12-15');
});

test('upfront monthly and quarterly eligibility uses saved dates, snapshot offsets and successor duration', () => {
  for (const period of ['annual', 'quarterly', 'monthly']) {
    const previous = term('2026-09-15', period);
    assert.equal(isAnnualNonRecurring(previous), true);
    const renewal = previous.membership_renewal_date;
    const result = classifyAnnualRenewal({
      previousRecord: previous, config: { ...oldConfig, billing_period: 'quarterly', renewal_open_days: 0 },
      now: new Date(`${renewal}T00:00:00Z`),
    });
    assert.equal(result.eligible, true);
    assert.equal(result.policy.windowDays, 30);
    assert.equal(result.target.start.toISOString().slice(0, 10), renewal);
    assert.equal(result.target.end.toISOString().slice(0, 10), buildRollingTerm({ startDate: renewal, billingPeriod: 'quarterly', previousTerm: previous }).term_end_date);
  }
});

test('zero-day rolling renewal opens on renewal day rather than expiring before opening', () => {
  const previous = term();
  previous.commitment_snapshot.config.renewal_open_days = 0;
  previous.commitment_snapshot.config.renewal_grace_days = 0;
  assert.equal(classifyAnnualRenewal({ previousRecord: previous, config: oldConfig, now: new Date('2027-09-14') }).eligible, false);
  assert.equal(classifyAnnualRenewal({ previousRecord: previous, config: oldConfig, now: new Date('2027-09-15') }).eligible, true);
});

test('authorised early upfront renewal snapshots a separate scheduled term without modifying the old price', () => {
  const previous = term();
  const config = { ...oldConfig, id: 'successor', flat_cost: 300 };
  const eligibility = classifyAnnualRenewal({ previousRecord: previous, config, now: new Date('2027-09-01') });
  const window = rollingMembershipWindow(config, previous.membership_renewal_date, previous);
  const snapshot = upfrontRollingCommitment({
    config, previousTerm: previous, membershipYear: window, annualCost: 300, finalCost: 300,
    vatAmount: 0, totalWithVat: 300, currency: 'GBP',
  });
  const scheduled = annualRecordSchedule({ ...eligibility, lifecycle: { termStart: snapshot.term_start_date, termEnd: snapshot.term_end_date, isEarly: true } });
  assert.equal(scheduled.status, 'scheduled');
  assert.equal(scheduled.scheduled_activation_date, '2027-09-15');
  assert.equal(snapshot.previous_term_id, previous.id);
  assert.equal(snapshot.commitment_snapshot.amounts.final_cost, 300);
  assert.equal(previous.final_cost, 240);
  assert.equal(classifyAnnualRenewal({ config, hasActiveMonthlyAgreement: true }).eligible, false);
});

test('legacy rolling term dates are not inferred from year labels or today', () => {
  assert.throws(() => deriveAnnualTerm({ membership_year: '2026/2027', term_start_date: '2026-09-15' }, oldConfig), /requires review/);
});

test('September commitment remains pinned; delayed renewal selects January price as of saved boundary', async () => {
  const previous = term();
  const successor = { ...oldConfig, id: 'new', flat_cost: 300, effective_from: '2027-01-01', effective_to: '2027-12-31' };
  const tooLate = { ...oldConfig, id: 'later', flat_cost: 360, effective_from: '2028-01-01' };
  const db = client({ member_membership_history: [previous], membership_tier_config: [successor, tooLate] });
  const current = await resolveRollingSimulationContext(db, { tenantId: 'tenant', memberId: 'member', config: successor, now: new Date('2027-06-01') });
  assert.equal(current.existing.final_cost, 240);
  const next = await resolveRollingSimulationContext(db, {
    tenantId: 'tenant', memberId: 'member', config: tooLate, now: new Date('2028-02-01'), options: { source: 'cron' },
  });
  assert.equal(next.config.id, 'new');
  assert.equal(next.window.label, 'rolling:2027-09-15');
  assert.equal(next.previousTerm.id, previous.id);
});

test('missing, overlapping, cross-tenant and unrelated-scope successor configurations fail closed', async () => {
  const previous = term();
  for (const configs of [
    [], [{ ...oldConfig, tenant_id: 'other' }],
    [{ ...oldConfig, structure_match_value: 'different', structure_field_id: 'field' }],
    [{ ...oldConfig, id: 'one' }, { ...oldConfig, id: 'two' }],
  ]) {
    await assert.rejects(resolveRollingSimulationContext(client({ member_membership_history: [previous], membership_tier_config: configs }), {
      tenantId: 'tenant', memberId: 'member', config: oldConfig, now: new Date('2027-09-15'), options: { source: 'cron' },
    }), /eligible|overlapping/);
  }
});

test('provider renewal contract accepts saved prior term; upfront cron cannot renew a recurring plan', async () => {
  const previous = term('2026-09-15', 'annual', { billing_agreement_id: 'agreement', billing_period: 'monthly_card' });
  const db = client({ member_membership_history: [previous], membership_tier_config: [oldConfig] });
  await assert.rejects(resolveRollingSimulationContext(db, { tenantId: 'tenant', memberId: 'member', config: oldConfig, now: new Date('2027-09-15'), options: { source: 'cron' } }), /recurring payment plan/);
  const result = await resolveRollingSimulationContext(db, {
    tenantId: 'tenant', memberId: 'member', config: oldConfig, now: new Date('2027-09-15'),
    options: { configId: 'old', asOfDate: '2027-09-15', termStartDate: '2027-09-15', previousTerm: previous },
  });
  assert.equal(result.window.term_start_date, '2027-09-15');
});

test('reminder candidates use trusted terms only and stop old reminders once successor is paid', () => {
  const previous = term('2026-01-15', 'monthly');
  const next = term('2026-02-15', 'monthly', { id: 'next' });
  assert.deepEqual(rollingReminderCandidates([previous, next], new Date('2026-02-16')).map(row => row.id), ['next']);
  assert.deepEqual(rollingReminderCandidates([{ id: 'legacy', membership_year: '2026' }], new Date('2026-02-16')), []);
});

test('rolling reminder offsets preserve calendar dates across server timezones', () => {
  assert.equal(rollingReminderSendDate('2027-09-15', { offset_value: 2, offset_unit: 'weeks', direction: 'before' }).toISOString().slice(0, 10), '2027-09-01');
  assert.equal(rollingReminderSendDate('2027-09-15', { offset_value: 7, offset_unit: 'days', direction: 'after' }).toISOString().slice(0, 10), '2027-09-22');
});

test('term-specific reminder claims block duplicate workers, reclaim stale/errors and isolate same-year terms', async () => {
  const db = client({});
  const identity = { tenant_id: 'tenant', reminder_id: 'reminder', membership_year: 'rolling:2026-01-15', member_id: 'member', scope_type: 'member' };
  const first = await claimRollingReminder(db, identity, new Date('2026-02-01T00:00:00Z'));
  assert.ok(first);
  assert.equal(await claimRollingReminder(db, identity, new Date('2026-02-01T00:01:00Z')), null);
  assert.ok(await claimRollingReminder(db, identity, new Date('2026-02-01T00:16:00Z')));
  assert.ok(await claimRollingReminder(db, { ...identity, membership_year: 'rolling:2026-02-15' }, new Date('2026-02-01T00:17:00Z')));
  await db.from('membership_tier_reminder_send').update({ status: 'sent' }).eq('id', first.id);
  assert.equal(await claimRollingReminder(db, identity, new Date('2026-02-02T00:00:00Z')), null);
});

test('future scheduled personal rolling membership does not protect an expired inherited membership', () => {
  const now = new Date('2027-09-20');
  const future = term('2027-10-01', 'annual', { status: 'scheduled' });
  assert.equal(isCurrentMembershipProtection(future, now), false);
  assert.equal(isCurrentMembershipProtection({ ...future, status: 'active' }, now), false);
  const current = term('2027-09-15');
  assert.equal(isCurrentMembershipProtection(current, now), true);
  assert.equal(isCurrentMembershipProtection(current, new Date('2028-09-15')), false);
  assert.equal(isCurrentMembershipProtection({ ...current, payment_status: 'unpaid' }, now), false);
  assert.equal(isCurrentMembershipProtection({ ...current, status: 'pending_approval' }, now), false);
  assert.equal(isCurrentMembershipProtection({ ...current, payment_status: 'unpaid', paid_at: 'not-a-date' }, now), false);
  for (const amount of [undefined, null, '', 'NaN', -1]) {
    assert.equal(isCurrentMembershipProtection({ ...current, total_with_vat: amount, final_cost: amount }, now), false);
  }
  assert.equal(isCurrentMembershipProtection({ ...current, total_with_vat: 0, final_cost: 0, payment_status: 'unpaid' }, now), false);
  assert.equal(isCurrentMembershipProtection({ ...current, total_with_vat: 0, final_cost: 0 }, now), true);
  assert.equal(isCurrentMembershipProtection({ status: 'scheduled', term_start_date: '2028-01-01', term_end_date: '2028-12-31' }, now), true);
});

test('only a settled adjacent linked rolling successor prevents expiry; later unrelated terms cannot', async () => {
  const prior = term();
  const boundary = { nextStart: new Date(prior.membership_renewal_date) };
  const next = term(prior.membership_renewal_date, 'annual', { id: 'next', previous_term_id: prior.id, status: 'scheduled' });
  const check = rows => hasSuccessfulNextTerm(client({ member_membership_history: rows }), 'member_membership_history', 'tenant', 'member_id', 'member', prior, boundary);
  for (const candidate of [
    { ...next, previous_term_id: 'unrelated' },
    term('2028-09-15', 'annual', { id: 'later', previous_term_id: prior.id }),
    { ...next, tenant_id: 'other' },
    { ...next, member_id: 'other' },
    { ...next, payment_status: 'unpaid', total_with_vat: 0, final_cost: 0 },
    { ...next, payment_status: 'unpaid', total_with_vat: null, final_cost: null },
    { ...next, total_with_vat: null, final_cost: null },
    { ...next, status: 'pending_approval' },
  ]) assert.equal(await check([candidate]), false);
  assert.equal(await check([
    { ...next, id: 'unpaid', payment_status: 'unpaid' },
    { ...next, id: 'approved-free', total_with_vat: 0, final_cost: 0 },
  ]), true);
  assert.equal(await check([next]), true);
});