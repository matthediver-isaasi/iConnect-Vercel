import test from 'node:test';
import assert from 'node:assert/strict';
import { canvasRenewalEligibility, loadCanvasRenewalEligibility } from './canvasRenewalEligibility.js';
import { resolveSavedCollectionPolicy } from '../../shared/gocardlessCollectionPolicy.js';

const config = { tenant_id: 'tenant', structure_scope_type: 'member', renewal_open_days: 10, renewal_grace_days: 5 };
const record = {
  id: 'term', tenant_id: 'tenant', membership_source: 'personal',
  payment_method: 'card', payment_status: 'paid', billing_period: 'annual',
  status: 'active', term_start_date: '2026-01-01', term_end_date: '2026-12-31',
};
const eligible = (today, patch = {}) => canvasRenewalEligibility({ record, config, today, ...patch }).eligible;
test('manual upfront terms can renew only with paid evidence and no recurring obligation', () => {
  const manual = { ...record, payment_method: 'manual' };
  assert.equal(eligible('2026-12-25', { record: manual }), true);
  for (const patch of [
    { payment_status: 'unpaid' }, { payment_status: 'partial' },
    { billing_agreement_id: 'agreement' }, { billing_period: 'monthly' },
    { commitment_snapshot: { payment_frequency: 'monthly' } },
  ]) assert.equal(eligible('2026-12-25', { record: { ...manual, ...patch } }), false);
});
test('continuing, finite and unknown-consent DD retain existing eligibility without policy reclassification', async () => {
  for (const [snapshot, end, review] of [
    [{ collection_policy: { version: 1, end_policy: 'continue', pricing_policy: 'dynamic' } }, 'continue', false],
    [{ collection_policy: { version: 1, end_policy: 'stop', pricing_policy: 'fixed' } }, 'stop', false],
    [{}, null, true],
  ]) {
    const before = structuredClone(snapshot);
    const policy = resolveSavedCollectionPolicy(snapshot);
    assert.equal(policy.end_policy, end);
    assert.equal(policy.needs_review, review);
    const dd = { ...record, payment_method: 'direct_debit', billing_period: 'monthly_direct_debit',
      billing_agreement_id: 'agreement' };
    assert.equal(eligible('2026-12-31', { record: dd }), false);
    assert.deepEqual(await loadCanvasRenewalEligibility({ from() { throw Error('Unexpected read'); } }, {
      selected: { record: dd }, owner: { tenant_id: 'tenant' }, history: [dd], today: '2026-12-31',
      plan: { membership_billing_agreements: { metadata: { dd: snapshot } } },
    }), { eligible: false });
    assert.deepEqual(snapshot, before);
  }
});
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

test('grace display preserves inclusive paid-through and grace boundaries', () => {
  for (const [today, inGrace] of [
    ['2026-12-30', false], ['2026-12-31', false], ['2027-01-01', true],
    ['2027-01-05', true], ['2027-01-06', false],
  ]) {
    const result = canvasRenewalEligibility({ record, config, today });
    assert.equal(result.inGrace, inGrace, today);
    assert.equal(result.paidThroughDate, '2026-12-31');
    assert.equal(result.graceEndDate, '2027-01-05');
  }
});

const tenant = 'ff2df806-b321-4254-b651-3af11fccf1db';
const legacyRecord = {
  id: 'fixture-legacy', member_id: 'fixture-member', tenant_id: tenant,
  membership_source: 'personal', membership_year: '2025/2026',
  status: 'active', payment_status: 'paid', payment_method: 'upfront',
  billing_period: 'annual', term_end_date: '2026-09-23',
  currency: 'GBP', tier_label: 'Full',
  final_cost: null, total_with_vat: null,
  notes: { source: 'bnms_non_dd_current_backfill' },
};
const boundaryConfig = {
  ...config, id: 'new-policy', tenant_id: tenant, name: 'Full',
  effective_from: '2026-09-01', renewal_grace_days: 90,
  structure_field_id: 'core:member_class', structure_match_value: 'Full',
};
const fixtureOwner = { id: 'fixture-member', tenant_id: tenant, member_class: 'Full' };
function fixtureDb(tables) {
  return { from(table) {
    let filters = [];
    const query = {
      select() { return query; },
      eq(key, value) { filters.push(row => row[key] === value); return query; },
      order() { return query; },
      maybeSingle() { return Promise.resolve({ data: (tables[table] || []).filter(row => filters.every(f => f(row)))[0] || null, error: null }); },
      range() { return Promise.resolve({ data: (tables[table] || []).filter(row => filters.every(f => f(row))), error: null }); },
    };
    return query;
  } };
}
async function loaded({ row = legacyRecord, configs = [boundaryConfig], owner = fixtureOwner,
  history = [row], agreements = [], today = '2026-09-24' } = {}) {
  return loadCanvasRenewalEligibility(fixtureDb({
    member: [owner], membership_tier_config: configs,
    membership_billing_agreements: agreements,
  }), { selected: { record: row }, owner, history, today });
}
test('legacy fallback is labelled display-only, matched at boundary not today; no record mutation', async () => {
  const before = JSON.stringify(legacyRecord);
  const configs = [
    { ...boundaryConfig, id: 'old', effective_from: '2025-01-01', effective_to: '2026-08-31', renewal_grace_days: 0 },
    { ...boundaryConfig, effective_to: '2026-10-01' },
    { ...boundaryConfig, id: 'future', effective_from: '2026-10-02', renewal_grace_days: 0 },
  ];
  for (const [today, inGrace] of [['2026-09-22', false], ['2026-09-23', false],
    ['2026-09-24', true], ['2026-12-22', true], ['2026-12-23', false]]) {
    const result = await loaded({ configs, today });
    assert.equal(result.inGrace, inGrace, today);
    assert.equal(result.graceEndDate, '2026-12-22');
    assert.equal(result.policySource, 'display_only_renewal_boundary');
  }
  assert.equal(JSON.stringify(legacyRecord), before);
});

test('explicit expiry-only authority wins over inferred structure and missing/forged authority does not override it', async () => {
  const row = { ...legacyRecord, term_end_date: '2026-09-25' };
  const tables = {
    member: [fixtureOwner], member_membership_history: [row],
    membership_tier_config: [{ ...boundaryConfig, billing_period: 'annual', renewal_grace_days: 0 }],
    membership_expiry_policy_assignment: [{
      id: 'approved', tenant_id: tenant, history_id: row.id, member_id: row.member_id,
      config_id: boundaryConfig.id, config_name: 'Approved renewal structure',
      expiry_date: row.term_end_date, approval_source: 'operator',
      policy_snapshot: { renewal_open_days: 90, renewal_grace_days: 90,
        renewal_disable_login: true, renewal_change_role: false, renewal_fallback_role_id: null },
    }],
  };
  for (const [today, eligible] of [['2026-12-24', true], ['2026-12-25', false]]) {
    const result = await loadCanvasRenewalEligibility(fixtureDb(tables), {
      selected: { record: row }, owner: fixtureOwner, history: [row], today,
    });
    assert.equal(result.eligible, eligible);
    assert.equal(result.graceEndDate, '2026-12-24');
    assert.equal(result.policySource, 'operator_assigned_expiry_only');
  }
  tables.membership_expiry_policy_assignment[0].expiry_date = '2026-09-26';
  const invalid = await loadCanvasRenewalEligibility(fixtureDb(tables), {
    selected: { record: row }, owner: fixtureOwner, history: [row], today: '2026-09-24',
  });
  assert.equal(invalid.eligible, false);
  assert.equal(invalid.reason, 'eligibility_evidence_unavailable');
});
test('ambiguous or missing selector and excluded evidence never create grace display', async () => {
  for (const input of [
    { configs: [boundaryConfig, { ...boundaryConfig, id: 'duplicate' }] },
    { owner: { ...fixtureOwner, member_class: null } },
    { owner: { ...fixtureOwner, membership_paused: true } },
    { row: { ...legacyRecord, status: 'cancelled' } },
    { row: { ...legacyRecord, payment_method: 'direct_debit' } },
    { history: [legacyRecord, { ...record, id: 'successor', previous_term_id: legacyRecord.id }] },
    { agreements: [{ tenant_id: tenant, member_id: fixtureOwner.id, status: 'active' }] },
  ]) assert.equal((await loaded(input)).inGrace, undefined);
});
test('saved history config and snapshot policy take priority including explicit zero grace', async () => {
  const saved = { ...boundaryConfig, id: 'saved', renewal_grace_days: 0 };
  const historyResult = await loaded({
    row: { ...record, tenant_id: tenant, term_end_date: '2026-09-23', config_id: 'saved' }, configs: [saved, boundaryConfig],
  });
  assert.equal(historyResult.inGrace, false);
  assert.equal(historyResult.policySource, 'saved_history_config');
  const snapshotResult = await loaded({
    row: { ...record, tenant_id: tenant, term_end_date: '2026-09-23',
      commitment_snapshot: { config: saved } },
  });
  assert.equal(snapshotResult.inGrace, false);
  assert.equal(snapshotResult.policySource, 'saved_snapshot');
});