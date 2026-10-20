import test from 'node:test';
import assert from 'node:assert/strict';
import { createMembershipSimulator } from './membershipSimulationCore.js';
import { createMembershipReminders } from './membershipReminders.js';
import { runAnnualOwnerRow } from './annualOwnerRenewalPipeline.js';
import { resolveEntityAnnualRenewalEligibility } from './annualRenewalPolicy.js';
import {
  assessMemberAmendmentOperationalScope, MEMBER_AMENDMENT_READER_READY_SCOPES,
  resolveMemberAmendmentReadOverlaysBatched,
} from './membershipAmendmentReadOverlay.js';
import { projectMembershipPaymentReport } from './membershipPaymentReport.js';

function fixture() {
  const original = { id: 'old', tenant_id: 'tenant', name: 'Original structure', start_mode: 'immediate',
    structure_scope_type: 'member', structure_field_id: 'field', structure_match_value: 'old',
    billing_period: 'annual', currency: 'GBP', pricing_model: 'flat', flat_cost: 100, is_active: true,
    renewal_open_days: 30, renewal_grace_days: 10, nominal_code: 'ORIGINAL', invoice_description: 'Original purchased invoice',
    online_card_payment: true };
  const target = { ...original, id: 'target', name: 'Applied structure', structure_match_value: 'applied',
    flat_cost: 300, nominal_code: 'TARGET', invoice_description: 'Next-term target invoice' };
  const history = { id: 'history', tenant_id: 'tenant', member_id: 'member', config_id: 'old',
    band_id: null, tier_label: 'Original tier', term_key: 'rolling:2026-01-01', term_anchor_date: '2026-01-01',
    membership_year: 'rolling:2026-01-01', term_start_date: '2026-01-01', term_end_date: '2026-12-31',
    membership_renewal_date: '2027-01-01', term_duration_months: 12, payment_status: 'paid', status: 'active',
    payment_method: 'card', billing_period: 'annual', currency: 'GBP', final_cost: 100, annual_cost: 100,
    total_with_vat: 100, vat_amount: 0, year_number: 2,
    commitment_snapshot: { config: original, config_id: 'old', start_mode: 'immediate', billing_period: 'annual',
      payment_frequency: 'upfront', payment_method: 'card', amounts: { final_cost: 100, total_with_vat: 100, currency: 'GBP' } } };
  const app = { id: 'application', amendment_id: 'amendment', tenant_id: 'tenant', member_id: 'member',
    source_record_id: 'history', effective_date: '2026-06-01', expires_on: '2027-01-01',
    snapshot: { sourceSnapshot: structuredClone(history), targetSnapshot: { config: target, band: null }, currency: 'GBP' } };
  const tables = {
    member: [{ id: 'member', tenant_id: 'tenant', first_name: 'Member', email: 'member@example.test',
      created_on: '2020-01-01', role_id: 'role' }],
    // Deliberately unchanged preferences point at the OLD scope.
    member_preference_value: [{ member_id: 'member', field_id: 'field', value: 'old' }],
    member_membership_history: [history], membership_tier_config: [original, target],
    member_membership_invoicing: [], member_membership_amendment_application: [app],
    membership_tier_reminder: [
      { id: 'old-reminder', tenant_id: 'tenant', config_id: 'old', is_active: true,
        email_template_id: 'old-template', offset_value: 30, direction: 'before', offset_unit: 'days' },
      { id: 'target-reminder', tenant_id: 'tenant', config_id: 'target', is_active: true,
        email_template_id: 'target-template', offset_value: 30, direction: 'before', offset_unit: 'days' },
    ],
    email_template: [
      { id: 'old-template', tenant_id: 'tenant', subject: 'WRONG original template', body: '{{tier_label}}' },
      { id: 'target-template', tenant_id: 'tenant', subject: 'Applied reminder', body: '{{tier_label}} {{final_cost}}' },
    ],
  };
  const calls = [];
  let amendmentError = null;
  const db = { from(table) {
    const filters = [];
    const call = { table, equals: {} };
    calls.push(call);
    let limit = Infinity, offset = 0;
    const result = single => {
      if (table === 'member_membership_amendment_application' && amendmentError) return { data: null, error: amendmentError };
      let data = (tables[table] || []).filter(row => filters.every(fn => fn(row))).slice(offset, offset + limit);
      return { data: single ? data[0] || null : structuredClone(data), error: null };
    };
    const q = {
      select() { return q; }, order() { return q; },
      eq(key, value) { call.equals[key] = value; filters.push(row => row[key] === value); return q; },
      is(key, value) { filters.push(row => value === null ? row[key] == null : row[key] === value); return q; },
      neq(key, value) { filters.push(row => row[key] !== value); return q; },
      gte(key, value) { filters.push(row => row[key] >= value); return q; },
      in(key, values) { filters.push(row => values.includes(row[key])); return q; },
      not(key, op, value) {
        filters.push(row => op === 'is' ? row[key] != null
          : !String(value).slice(1, -1).split(',').includes(row[key]));
        return q;
      },
      or() { return q; },
      limit(n) { limit = n; return q; }, range(start, end) { offset = start; limit = end - start + 1; return q; },
      maybeSingle: async () => result(true), single: async () => result(true),
      then(resolve, reject) { return Promise.resolve(result(false)).then(resolve, reject); },
      insert() { assert.fail('Database writes are forbidden'); }, update() { assert.fail('Database writes are forbidden'); },
      upsert() { assert.fail('Database writes are forbidden'); }, delete() { assert.fail('Database writes are forbidden'); },
    };
    return q;
  } };
  return { original, target, history, app, db, tables, calls, failAmendmentRead: () => { amendmentError = { code: '42501' }; } };
}
const render = (text, entity, data) => text?.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => data[key] ?? '') || '';
function reminders(f, now) {
  const effects = [];
  const simulator = createMembershipSimulator(f.db, () => now);
  const service = createMembershipReminders({
    db: f.db, now, simulateMembershipForMember: simulator.simulateMembershipForMember,
    simulateMembershipForOrg: async () => { assert.fail('No organisation simulation expected'); },
    getPausedMemberIdSet: async () => new Set(), replacePlaceholders: render,
    loadAddonLines: async () => [], computeAddonTotals: () => ({ subtotal: 0, vat: 0, total: 0 }),
    buildAddonDisplayLines: () => [], getStripeCredentials: async () => ({ is_enabled: true, secret_key: 'isolated', publishable_key: 'isolated' }),
    effects: { async perform(operation) {
      effects.push(operation);
      if (operation.type === 'reminder.claim') return { data: { id: 'claim', sent_at: now.toISOString() } };
      if (operation.type === 'reminder.prepare_token') return {
        success: true, paymentUrl: 'https://example.test/isolated-payment', costBreakdown: operation.payload.costBreakdown,
        finalCost: operation.payload.finalCost, currency: operation.payload.currency, tierLabel: operation.payload.tierLabel,
      };
      if (operation.type === 'reminder.email') return { success: true };
      return {};
    } },
  });
  return { service, effects };
}

test('operational readiness names exactly the audited source/target scope and rejects fixed/cadence/provider/legacy changes', () => {
  const f = fixture();
  assert.deepEqual(MEMBER_AMENDMENT_READER_READY_SCOPES, ['personal_annual_upfront_rolling_immediate_to_immediate']);
  assert.equal(assessMemberAmendmentOperationalScope({ current: f.history, config: f.target }).supported, true);
  for (const config of [{ ...f.target, start_mode: 'fixed_date' }, { ...f.target, billing_period: 'monthly' },
    { ...f.target, structure_scope_type: 'organization' }, { ...f.target, tenant_id: 'other' }]) {
    assert.equal(assessMemberAmendmentOperationalScope({ current: f.history, config }).supported, false);
  }
  for (const current of [{ ...f.history, billing_agreement_id: 'agreement' }, { ...f.history, term_key: null },
    { ...f.history, term_duration_months: 3 },
    { ...f.history, commitment_snapshot: { ...f.history.commitment_snapshot, start_mode: 'fixed_date' } }]) {
    assert.equal(assessMemberAmendmentOperationalScope({ current, config: f.target }).supported, false);
  }
});

test('real current simulation exposes applied structure/tier but retains original purchase finances', async () => {
  const f = fixture();
  const sim = await createMembershipSimulator(f.db, () => new Date('2026-12-15')).simulateMembershipForMember('tenant', 'member', { source: 'tab' });
  assert.equal(sim.success, true, sim.error);
  assert.equal(sim.config.id, 'target');
  assert.equal(sim.tierLabel, 'Applied structure');
  assert.equal(sim.finalCost, 100);
  assert.equal(sim.totalWithVat, 100);
  assert.equal(sim.existingRecord.config_id, 'old');
  assert.equal(sim.originalPurchaseConfig.id, 'old');
  assert.equal(sim.nominalCode, 'ORIGINAL');
});

test('real cron simulation follows applied rolling scope despite unchanged old preferences and a fixed-date live config', async () => {
  const f = fixture();
  // This is the audited alternative to supporting fixed-date applications:
  // mutable live configuration may become fixed-date, but purchased rolling
  // terms must still take the rolling branch and use applied scope.
  f.tables.membership_tier_config[0] = { ...f.original, start_mode: 'fixed_date' };
  const sim = await createMembershipSimulator(f.db, () => new Date('2027-01-01')).simulateMembershipForMember('tenant', 'member', { source: 'cron' });
  assert.equal(sim.success, true, sim.error);
  assert.equal(sim.config.id, 'target');
  assert.equal(sim.finalCost, 300);
  assert.equal(sim.membershipYear.start.toISOString().slice(0, 10), '2027-01-01');
  assert.equal(f.history.final_cost, 100);
  assert.equal(f.history.config_id, 'old');
});

test('actual annual owner cron preparation creates only a target-scope successor operation without DB effects', async () => {
  const f = fixture();
  const operations = [];
  await runAnnualOwnerRow({ db: f.db, tenantId: 'tenant', scope: 'member',
    setting: { member_id: 'member', invoicing_mode: 'automatic' }, now: new Date('2027-01-01'),
    effects: { async perform(operation) { operations.push(operation); return { recorded: true }; } } });
  assert.equal(operations.length, 1);
  assert.equal(operations[0].type, 'owner.annual_history_insert');
  assert.equal(operations[0].payload.values.config_id, 'target');
  assert.equal(operations[0].payload.values.final_cost, 300);
  assert.equal(operations[0].payload.values.previous_term_id, 'history');
  assert.equal(f.history.final_cost, 100);
});

test('existing purchased-term invoice preparation retains original nominal code/description and paid finances', async () => {
  const f = fixture();
  const now = new Date('2026-12-15');
  const saved = await createMembershipSimulator(f.db, () => now).simulateMembershipForMember('tenant', 'member', { source: 'tab' });
  const operations = [];
  await runAnnualOwnerRow({ db: f.db, tenantId: 'tenant', scope: 'member',
    setting: { member_id: 'member', invoicing_mode: 'scheduled', invoice_date: '2026-12-01' }, now,
    simulator: { simulateMembershipForMember: async () => saved },
    effects: { async perform(operation) { operations.push(operation); return { recorded: true }; } } });
  assert.equal(operations.length, 1);
  assert.equal(operations[0].type, 'owner.annual_invoice');
  assert.equal(operations[0].payload.invoice.finalCost, 100);
  assert.equal(operations[0].payload.invoice.nominalCode, 'ORIGINAL');
  assert.equal(operations[0].payload.invoice.invoiceDescription, 'Original purchased invoice');
  assert.equal(operations[0].payload.invoice.tierLabel, 'Original tier');
  assert.equal(operations[0].payload.sim.config.id, 'old');
  assert.equal(f.history.total_with_vat, 100);
});

test('annual renewal eligibility uses applied policy, not original policy, after expiry', async () => {
  const f = fixture();
  f.app.snapshot.targetSnapshot.config.renewal_grace_days = 0;
  const eligibility = await resolveEntityAnnualRenewalEligibility(f.db, {
    tenantId: 'tenant', memberId: 'member', config: f.target,
    membershipYear: { label: 'rolling:2027-01-01', start: new Date('2027-01-01'), end: new Date('2027-12-31') },
    now: new Date('2027-01-02'),
  });
  assert.equal(eligibility.eligible, false);
});

test('informational rolling reminder loads target reminder config and target label while retaining paid amount', async () => {
  const f = fixture();
  const { service, effects } = reminders(f, new Date('2026-12-15'));
  await service.processRollingReminders('tenant', { details: [] }, new Date('2026-12-15'));
  const emails = effects.filter(op => op.type === 'reminder.email');
  assert.equal(emails.length, 1);
  assert.equal(emails[0].payload.subject, 'Applied reminder');
  assert.match(emails[0].payload.html, /Applied structure 100.00/);
  const reminderReads = f.calls.filter(call => call.table === 'membership_tier_reminder');
  assert.equal(reminderReads[0].equals.config_id, 'target');
  assert.equal(f.history.tier_label, 'Original tier');
});

test('payment-link reminder freezes a target-scope renewal quote, not mutable original preferences', async () => {
  const f = fixture();
  f.tables.email_template[1].body += ' {{payment_link}}';
  const { service, effects } = reminders(f, new Date('2026-12-15'));
  await service.processPaymentLinkReminders('tenant', { details: [] }, new Date('2026-12-15'));
  const tokens = effects.filter(op => op.type === 'reminder.prepare_token');
  assert.equal(tokens.length, 1);
  assert.equal(tokens[0].payload.tierConfig.id, 'target');
  assert.equal(tokens[0].payload.finalCost, 300);
  assert.equal(tokens[0].payload.costBreakdown.renewalQuote.previousTerm.effective_config_id, 'target');
  assert.equal(effects.filter(op => op.type === 'reminder.email')[0].payload.subject, 'Applied reminder');
});

test('fixed-config reminder stream cannot steal an amended rolling member when mutable live config becomes fixed-date', async () => {
  const f = fixture();
  f.tables.membership_tier_config[0] = { ...f.original, start_mode: 'fixed_date' };
  const { service, effects } = reminders(f, new Date('2026-12-15'));
  await service.processFixedReminders('tenant', { details: [] });
  assert.equal(effects.length, 0);
});

test('report current membership label is applied; preference-based future grouping remains explicitly only a projection', async () => {
  const f = fixture();
  const history = await resolveMemberAmendmentReadOverlaysBatched({
    db: f.db, tenantId: 'tenant', history: [f.history], asOf: '2026-12-15',
  });
  const rows = projectMembershipPaymentReport({ tenantId: 'tenant', members: f.tables.member,
    history, today: '2026-12-15', configs: f.tables.membership_tier_config,
    preferences: f.tables.member_preference_value.map(row => ({ ...row, tenant_id: 'tenant' })) });
  assert.equal(rows[0].tier, 'Applied structure');
  assert.equal(rows[0].nextStructureId, 'old');
  assert.match(rows[0].nextStructureState, /not a commitment/);
  assert.equal(f.history.final_cost, 100);
});

test('large report history reads application evidence in batches instead of N+1 member queries', async () => {
  const f = fixture();
  const history = [f.history, ...Array.from({ length: 250 }, (_, i) => ({
    ...structuredClone(f.history), id: `unamended-${i}`, member_id: `member-${i}`,
  }))];
  const rows = await resolveMemberAmendmentReadOverlaysBatched({ db: f.db, tenantId: 'tenant', history, asOf: '2026-12-15' });
  assert.equal(rows.length, 251);
  assert.equal(rows[0].effective_config_id, 'target');
  assert.equal(rows[1].effective_config_id, undefined);
  assert.equal(f.calls.filter(call => call.table === 'member_membership_amendment_application').length, 3);
});

test('failed amendment reads stop automated renewal and reminders before any operation', async () => {
  const f = fixture();
  f.failAmendmentRead();
  const sim = await createMembershipSimulator(f.db, () => new Date('2027-01-01')).simulateMembershipForMember('tenant', 'member', { source: 'cron' });
  assert.equal(sim.success, false);
  assert.match(sim.error, /amendment evidence could not be read/i);
  const { service, effects } = reminders(f, new Date('2026-12-15'));
  await assert.rejects(service.processRollingReminders('tenant', { details: [] }, new Date('2026-12-15')), /evidence could not be read/);
  assert.equal(effects.length, 0);
});

test('an out-of-scope fixed-date application cannot enter automated rolling renewal or reminders', async () => {
  const f = fixture();
  f.app.snapshot.targetSnapshot.config.start_mode = 'fixed_date';
  const sim = await createMembershipSimulator(f.db, () => new Date('2027-01-01')).simulateMembershipForMember('tenant', 'member', { source: 'cron' });
  assert.equal(sim.success, false);
  assert.match(sim.error, /outside the audited operational reader scope/);
  const { service, effects } = reminders(f, new Date('2026-12-15'));
  await assert.rejects(service.processPaymentLinkReminders('tenant', { details: [] }, new Date('2026-12-15')), /outside the audited/);
  assert.equal(effects.length, 0);
});
