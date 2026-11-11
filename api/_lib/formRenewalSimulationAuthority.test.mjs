import test from 'node:test';
import assert from 'node:assert/strict';
import { createMembershipSimulator } from './membershipSimulationCore.js';
import { FORM_RENEWAL_SIMULATION_AUTHORITY as AUTHORITY } from './formRenewalSimulationAuthority.js';
import { buildRollingTerm } from '../../shared/rollingMembershipTerm.js';

const old = { id: 'old', tenant_id: 'tenant', start_mode: 'immediate', structure_scope_type: 'member',
  structure_field_id: 'class', structure_match_value: 'Full with NMC', billing_period: 'annual', is_active: true };
const target = { ...old, id: 'new', structure_match_value: 'Full' };
const previous = { ...buildRollingTerm({ startDate: '2025-12-02', billingPeriod: 'annual' }),
  id: 'history', tenant_id: 'tenant', member_id: 'member', status: 'active', payment_status: 'paid',
  commitment_snapshot: { start_mode: 'immediate', config: old, payment_frequency: 'upfront' } };
const authority = { tenantId: 'tenant', memberId: 'member', predecessorId: 'history', configId: 'new', start: '2026-12-02' };
function fixture() {
  const tables = { member_membership_history: [structuredClone(previous)], membership_tier_config: [old, target] };
  const db = { from(table) {
    let rows = tables[table] || [];
    const q = { select: () => q, eq: (k, v) => { rows = rows.filter(r => r[k] === v); return q; },
      or: () => q, order: () => q, then: resolve => resolve({ data: rows }) };
    return q;
  } };
  const options = { source: 'form-renewal', configId: 'new', previousTerm: previous,
    asOfDate: '2026-12-02', termStartDate: '2026-12-02', [AUTHORITY]: authority };
  return { tables, options, run: (overrides = {}) => createMembershipSimulator(db).resolveRollingSimulationContext(db,
    { tenantId: 'tenant', memberId: 'member', config: target, options, now: new Date('2026-11-11'), ...overrides }) };
}
test('validated form selection changes only the next rolling schedule and preserves dates', async () => {
  const f = fixture();
  const result = await f.run();
  assert.equal(result.config.id, 'new');
  assert.equal(result.window.start.toISOString().slice(0, 10), '2026-12-02');
  assert.equal(result.window.end.toISOString().slice(0, 10), '2027-12-01');
  assert.deepEqual(f.tables.member_membership_history[0], previous);
});
test('ordinary renewal and JSON-forged selection cannot override saved schedule', async () => {
  const f = fixture();
  delete f.options[AUTHORITY];
  f.options.renewalScheduleSelection = authority;
  await assert.rejects(f.run(), /eligible structure/);
});
test('form authority is bound to tenant, owner, predecessor, schedule and dates', async () => {
  for (const key of ['tenantId', 'memberId', 'predecessorId', 'configId', 'start']) {
    const f = fixture(); f.options[AUTHORITY] = { ...authority, [key]: 'other' };
    await assert.rejects(f.run(), /validated predecessor/);
  }
  for (const override of [{ tenant_id: 'other' }, { is_active: false }, { structure_scope_type: 'organization' },
    { effective_from: '2027-01-01' }, { effective_to: '2026-11-30' }]) {
    await assert.rejects(fixture().run({ config: { ...target, ...override } }), /validated predecessor/);
  }
  const f = fixture(); f.options.source = 'cron';
  await assert.rejects(f.run(), /validated predecessor/);
});
