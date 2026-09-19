import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

let root, temporaryRoot, pause, reminders, dd, card, setDatabase, setSimulationError, setTermError;
before(async () => {
  temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'renewal-stage-budgets-'));
  root = path.join(temporaryRoot, 'api', '_lib');
  await mkdir(root, { recursive: true });
  await mkdir(path.join(temporaryRoot, 'shared'));
  await writeFile(path.join(temporaryRoot, 'package.json'), '{"type":"module"}');
  await cp(new URL('../../shared/gocardlessCollectionPolicy.js', import.meta.url), path.join(temporaryRoot, 'shared', 'gocardlessCollectionPolicy.js'));
  await writeFile(path.join(root, 'package.json'), '{"type":"module"}');
  for (const name of ['memberPause.js', 'membershipReminders.js', 'membershipRenewalBudget.js', 'gocardlessDdRenewals.js', 'stripeCardRenewals.js']) {
    await cp(new URL(name, import.meta.url), path.join(root, name));
  }
  const forbidden = '() => { throw new Error("Live effect forbidden in stage budget tests"); }';
  const exports = names => names.map(name => `export const ${name} = ${forbidden};`).join('\n');
  const stubs = {
    'database.js': 'export let supabase; export function setDatabase(db) { supabase = db; }',
    'session.js': exports(['invalidateMemberSessions']),
    'gocardless.js': exports(['gocardlessForTenant', 'buildIdempotencyKey']),
    'gocardlessState.js': 'export const STATUS = {};',
    'xero.js': exports(['assertBnmsPilotAccountingContext']),
    'membershipSimulation.js': 'let failure; export function setSimulationError(error) { failure = error; } export async function simulateMembershipForMember() { if (failure) throw failure; return { success: false }; } export const simulateMembershipForOrg = simulateMembershipForMember;',
    'tenantEmailService.js': exports(['sendTenantEmail']),
    'reminderPaymentQuote.js': `export const requestsReminderPaymentLink = () => false; ${exports(['resolveReminderPaymentQuote'])}`,
    'membershipFeeTokenEmail.js': exports(['prepareMembershipFeeToken']),
    'membershipAddons.js': exports(['loadAddonLines', 'computeAddonTotals', 'buildAddonDisplayLines']),
    'annualRenewalPolicy.js': exports(['deriveAnnualTerm']),
    'emailService.js': exports(['replacePlaceholders']),
    'transactionalInbox.js': exports(['buildInboxDelivery', 'recordTransactionalInboxMessage', 'resolveCommunicationCategoryIdForLabel']),
    'gocardlessDirectDebit.js': exports(['resolveDdOffer', 'buildAgreementSnapshot', 'findReusableMandate', 'ensureSubscriptionForAgreement', 'activateMembershipForAgreement']),
    'gocardlessDdEmails.js': exports(['sendDdLifecycleEmail', 'resolveDdEmailRecipients']),
    'monthlyArrearsCollection.js': exports(['assertNoOpenMonthlyArrears']),
    'stripeCredentials.js': exports(['getStripeCredentials']),
    'stripeMonthlyCard.js': `export const CARD_PLAN_KIND = 'monthly_card'; ${exports(['resolveCardMonthlyOffer', 'buildCardAgreementSnapshot', 'ensureCardPlanForCheckout'])}`,
    'rollingMonthlyRenewal.js': `export const monthlySnapshotCommitment = () => null;
      let failure; export function setTermError(error) { failure = error; }
      export const assertTrustedMonthlyTerm = async () => { if (failure) throw failure; };
      ${exports(['monthlyRenewalIdentity', 'simulateMonthlySuccessor', 'reserveRollingMonthlyRenewal', 'completeRollingMonthlySetup', 'sendRollingMonthlyNotice', 'assertMonthlyCollectionsWithinTerm'])}`,
  };
  for (const [name, content] of Object.entries(stubs)) await writeFile(path.join(root, name), content);
  ({ setDatabase } = await import(pathToFileURL(path.join(root, 'database.js'))));
  ({ setSimulationError } = await import(pathToFileURL(path.join(root, 'membershipSimulation.js'))));
  ({ setTermError } = await import(pathToFileURL(path.join(root, 'rollingMonthlyRenewal.js'))));
  pause = await import(pathToFileURL(path.join(root, 'memberPause.js')));
  reminders = await import(pathToFileURL(path.join(root, 'membershipReminders.js')));
  dd = await import(pathToFileURL(path.join(root, 'gocardlessDdRenewals.js')));
  card = await import(pathToFileURL(path.join(root, 'stripeCardRenewals.js')));
});
after(async () => { if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true }); });

const id = n => String(n).padStart(6, '0');
function fakeDb(tables, { cap = 23, failTable = null } = {}) {
  const calls = [];
  const value = (row, key) => key.split(/->>?/).reduce((v, field) => v?.[field], row);
  return { calls, from(table) {
    const filters = [];
    const orders = [];
    let limit = cap, update = null, single = false, insert = null;
    const chain = {
      select() { return this; },
      eq(key, expected) { filters.push(row => value(row, key) === expected); return this; },
      gt(key, expected) { filters.push(row => value(row, key) > expected); return this; },
      gte(key, expected) { filters.push(row => value(row, key) >= expected); return this; },
      lte(key, expected) { filters.push(row => value(row, key) <= expected); return this; },
      neq(key, expected) { filters.push(row => value(row, key) !== expected); return this; },
      is(key, expected) { filters.push(row => (value(row, key) ?? null) === expected); return this; },
      not(key, op, expected) {
        if (op === 'is') filters.push(row => value(row, key) != null);
        else if (op === 'in') filters.push(row => !expected.slice(1, -1).split(',').includes(value(row, key)));
        return this;
      },
      in(key, expected) { filters.push(row => expected.includes(value(row, key))); return this; },
      or(expression) {
        if (expression.startsWith('metadata')) filters.push(row => !row.metadata?.renewal_setup_pending);
        else filters.push(row => row.payment_status === 'paid' || !!row.paid_at);
        return this;
      },
      order(key, options) { orders.push([key, options.ascending]); return this; },
      limit(n) { limit = Math.min(n, cap); return this; },
      update(values) { update = values; return this; },
      insert(values) { insert = values; return this; },
      maybeSingle() { single = true; return this; },
      then(resolve, reject) {
        try {
          calls.push(table);
          if (table === failTable) return resolve({ data: null, error: { message: 'isolated query failure' } });
          const rows = tables[table] || [];
          if (insert) { rows.push(insert); return resolve({ data: [], error: null }); }
          let selected = rows.filter(row => filters.every(filter => filter(row)));
          selected.sort((a, b) => {
            for (const [key, ascending] of orders) {
              const difference = String(value(a, key)).localeCompare(String(value(b, key)));
              if (difference) return ascending ? difference : -difference;
            }
            return 0;
          });
          selected = selected.slice(0, limit);
          if (update) selected.forEach(row => Object.assign(row, update));
          resolve({ data: single ? selected[0] || null : selected, error: null });
        } catch (error) { reject(error); }
      },
    };
    return chain;
  } };
}

function controlFor(cursor, limit = Infinity) {
  const checkpoints = [];
  return {
    cursor,
    checkpoints,
    shouldContinue: () => checkpoints.length < limit,
    async checkpoint(next) { checkpoints.push(next); this.cursor = next; },
  };
}
function results(control) { return { errors: 0, processed: 0, skipped: 0, details: [], __renewalControl: control }; }

test('paused set scans beyond server cap and actual lookup failures fail closed', async () => {
  const rows = Array.from({ length: 1107 }, (_, n) => ({ id: id(n), tenant_id: 'tenant', membership_paused: true }));
  const db = fakeDb({ member: rows });
  assert.equal((await pause.getPausedMemberIdSet('tenant', db)).size, rows.length);
  await assert.rejects(pause.getPausedMemberIdSet('tenant', fakeDb({}, { failTable: 'member' })), /Could not check paused/);
});

test('pause resumes use safe per-row checkpoints and continue beyond a capped page', async () => {
  const rows = Array.from({ length: 80 }, (_, n) => ({
    id: id(n), tenant_id: 'tenant', membership_paused: true, membership_pause_restart_date: '2020-01-01',
    membership_pause_gc_subscriptions: [],
  }));
  const db = fakeDb({ member: rows, member_note: [] });
  const first = controlFor(null, 27);
  await assert.rejects(pause.processPauseAutoRestarts(results(first), { db }), { code: 'RENEWAL_BUDGET_EXHAUSTED' });
  assert.equal(rows.filter(row => !row.membership_paused).length, 27);
  const second = controlFor(first.cursor);
  await pause.processPauseAutoRestarts(results(second), { db });
  assert.equal(rows.filter(row => !row.membership_paused).length, 80);
  assert.equal(second.checkpoints.length, 53);
});

for (const provider of ['dd', 'card']) {
  test(`${provider} nested budget exhaustion is a deferral, not a recorded row error`, async () => {
    const kind = provider === 'dd' ? 'monthly_direct_debit' : 'monthly_card';
    const db = fakeDb({ membership_billing_agreements: [{
      id: 'agreement', tenant_id: 'tenant', member_id: 'member', agreement_type: 'member',
      created_at: '2026-01-01', metadata: { [provider]: { kind } },
    }] });
    const control = controlFor(null);
    const summary = results(control);
    const failure = Object.assign(new Error('deferred'), { code: 'RENEWAL_BUDGET_EXHAUSTED' });
    setTermError(failure);
    try {
      const run = provider === 'dd' ? dd.processTenantDdRenewals : card.processTenantCardRenewals;
      await assert.rejects(run('tenant', summary, { db }), error => error === failure);
      assert.equal(summary.errors, 0);
      assert.deepEqual(control.checkpoints, []);
    } finally { setTermError(null); }
  });

  test(`${provider} stage checkpoints capped pages, resumes, and never skips latest agreement on another page`, async () => {
    const kind = provider === 'dd' ? 'monthly_direct_debit' : 'monthly_card';
    const agreements = Array.from({ length: 103 }, (_, n) => ({
      id: id(n), tenant_id: 'tenant', member_id: `member-${n}`, agreement_type: 'member',
      created_at: '2026-01-01', metadata: { [provider]: { kind, membership_year_start: '2099-01-01' } },
    }));
    agreements.push({ ...agreements[0], id: '999999', created_at: '2027-01-01' });
    const db = fakeDb({ membership_billing_agreements: agreements });
    const run = provider === 'dd' ? dd.processTenantDdRenewals : card.processTenantCardRenewals;
    const first = controlFor(null, 37);
    await assert.rejects(run('tenant', results(first), { db }), { code: 'RENEWAL_BUDGET_EXHAUSTED' });
    const second = controlFor(first.cursor);
    await run('tenant', results(second), { db });
    assert.deepEqual([...first.checkpoints, ...second.checkpoints], agreements.map(row => row.id));
  });

  test(`${provider} stage query failure is not checkpointed as completion`, async () => {
    const control = controlFor(null);
    const run = provider === 'dd' ? dd.processTenantDdRenewals : card.processTenantCardRenewals;
    await assert.rejects(run('tenant', results(control), {
      db: fakeDb({}, { failTable: 'membership_billing_agreements' }),
    }), /isolated query failure/);
    assert.deepEqual(control.checkpoints, []);
  });
}

test('card payment-method lookup does not translate budget exhaustion to an unusable card', async () => {
  const failure = Object.assign(new Error('deferred'), { code: 'RENEWAL_BUDGET_EXHAUSTED' });
  await assert.rejects(card.findReusableCardPaymentMethod({
    stripe: { customers: { retrieve: async () => { throw failure; } } },
    previousAgreement: { stripe_customer_id: 'customer' },
  }), error => error === failure);
});

test('reminder simulation preserves budget exhaustion and the unfinished member cursor', async () => {
  setDatabase(fakeDb({
    member: [{ id: 'member', tenant_id: 'tenant', email: 'test@example.invalid', organization_id: null }],
    membership_tier_config: [{ id: 'config', tenant_id: 'tenant', structure_scope_type: 'member', start_mode: 'fixed', effective_to: null }],
    membership_tier_reminder: [{ id: 'reminder', tenant_id: 'tenant', config_id: 'config', is_active: true }],
  }));
  const control = controlFor(null);
  const summary = results(control);
  const failure = Object.assign(new Error('deferred'), { code: 'RENEWAL_BUDGET_EXHAUSTED' });
  setSimulationError(failure);
  try {
    await assert.rejects(reminders.processTenantReminders('tenant', summary), error => error === failure);
    assert.equal(control.cursor['fixed:config'], undefined);
    assert.equal(summary.errors, 0);
  } finally { setSimulationError(null); }
});

test('reminder composite cursor resumes within config and traverses more than response cap', async () => {
  const members = Array.from({ length: 1011 }, (_, n) => ({
    id: id(n), tenant_id: 'tenant', email: `member-${n}@example.invalid`, organization_id: null,
  }));
  const db = fakeDb({
    member: members,
    membership_tier_config: [{ id: 'config', tenant_id: 'tenant', structure_scope_type: 'member', start_mode: 'fixed', effective_to: null }],
    membership_tier_reminder: [{ id: 'reminder', tenant_id: 'tenant', config_id: 'config', is_active: true }],
  });
  setDatabase(db);
  const first = controlFor(null, 41);
  await assert.rejects(reminders.processTenantReminders('tenant', results(first)), { code: 'RENEWAL_BUDGET_EXHAUSTED' });
  assert.equal(typeof first.cursor['fixed:config'], 'string');
  const second = controlFor(first.cursor);
  await reminders.processTenantReminders('tenant', results(second));
  assert.equal(second.cursor['fixed:config'], true);
  assert.equal(second.cursor.configs, true);
  const visited = [...first.checkpoints, ...second.checkpoints]
    .map(cursor => cursor['fixed:config']).filter(value => typeof value === 'string');
  assert.equal(new Set(visited).size, members.length);
});