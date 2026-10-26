import test from 'node:test';
import assert from 'node:assert/strict';
import { projectMonthlyEntitlement, resolveMonthlyEntitlements } from './memberMonthlyEntitlement.js';
import { resolveMemberAmendmentReadOverlay, resolveMemberAmendmentReadOverlaysBatched,
  effectiveMemberEntitlement } from './membershipAmendmentReadOverlay.js';

function fixture() {
  const history = {
    id: 'history', tenant_id: 'tenant', member_id: 'member', billing_agreement_id: 'agreement',
    membership_source: 'personal', config_id: 'old', band_id: null, term_key: 'rolling:2026-01-01',
    term_start_date: '2026-01-01', membership_renewal_date: '2027-01-01', currency: 'GBP',
    final_cost: 100, accounting_invoice_id: 'original',
    commitment_snapshot: { payment_frequency: 'monthly', config: { id: 'old' } },
  };
  const operation = {
    id: 'operation', operation_key: 'key', state: 'finalized', tenant_id: 'tenant',
    member_id: 'member', source_record_id: 'history', plan_id: 'plan',
    prepared: { input: { purchase: structuredClone(history), agreement: { id: 'agreement' }, plan: { id: 'plan' } } },
    evidence: { application: {
      operationId: 'operation', effectiveDate: '2026-06-01', expiresOn: '2027-01-01',
      appliedAt: '2026-05-20T12:00:00Z',
      targetSnapshot: { config: { id: 'new', tenant_id: 'tenant', structure_scope_type: 'member', name: 'New' }, band: null },
    } },
  };
  return { history, operation };
}
test('monthly entitlement follows effective date without rewriting purchased prices or consent', () => {
  const { history, operation } = fixture();
  const before = structuredClone(history);
  for (const asOf of ['2026-05-31', '2027-01-01']) {
    assert.equal(projectMonthlyEntitlement(history, operation, { tenantId: 'tenant', asOf }).effective_config_id, undefined);
  }
  const result = projectMonthlyEntitlement(history, operation, { tenantId: 'tenant', asOf: '2026-06-01' });
  assert.equal(result.effective_config_id, 'new');
  assert.equal(result.config_id, 'old');
  assert.equal(result.final_cost, 100);
  assert.equal(result.accounting_invoice_id, 'original');
  assert.deepEqual(history, before);
  assert.deepEqual(result.commitment_snapshot, before.commitment_snapshot);
  assert.equal(projectMonthlyEntitlement(history, operation,
    { tenantId: 'tenant', asOf: '2027-02-01', renewal: true }).effective_config_id, 'new');
});
test('provider success without atomic finalization never grants entitlement', () => {
  const { history, operation } = fixture();
  operation.state = 'provider_applied';
  assert.throws(() => projectMonthlyEntitlement(history, operation, { tenantId: 'tenant' }),
    { code: 'monthly_entitlement_invalid' });
});
test('foreign owners, changed source, wrong bands and extended expiry fail closed', () => {
  const changes = [
    o => { o.member_id = 'other'; },
    o => { o.tenant_id = 'other'; },
    o => { o.prepared.input.purchase.term_key = 'other'; },
    o => { o.evidence.application.expiresOn = '2028-01-01'; },
    o => { o.evidence.application.targetSnapshot.band = { tenant_id: 'other', config_id: 'new' }; },
    o => { delete o.evidence.application; },
  ];
  for (const change of changes) {
    const { history, operation } = fixture(); change(operation);
    assert.throws(() => projectMonthlyEntitlement(history, operation, { tenantId: 'tenant' }),
      { code: 'monthly_entitlement_invalid' });
  }
});
test('reader distinguishes absent migration from failure and rejects ambiguous applications', async () => {
  const f = fixture();
  let response = { data: [f.operation] };
  const filters = [];
  const q = { select() { return this; }, eq(...args) { filters.push(args); return this; },
    in() { return this; }, order() { return this; }, range() { return this; },
    then(resolve, reject) { return Promise.resolve(response).then(resolve, reject); } };
  const args = { db: { from: () => q }, tenantId: 'tenant', history: [f.history], asOf: '2026-07-01' };
  assert.equal((await resolveMonthlyEntitlements(args))[0].effective_config_id, 'new');
  assert.ok(filters.some(([key, value]) => key === 'state' && value === 'finalized'));
  response = { error: { code: 'PGRST205' } };
  assert.deepEqual(await resolveMonthlyEntitlements(args), [f.history]);
  response = { error: { code: '42501' } };
  await assert.rejects(resolveMonthlyEntitlements(args), { code: 'monthly_entitlement_unavailable' });
  response = { data: [f.operation, f.operation] };
  await assert.rejects(resolveMonthlyEntitlements(args), { code: 'monthly_entitlement_invalid' });
});
test('shared single and report readers expose monthly scope through the existing entitlement interface', async () => {
  const f = fixture();
  const tables = [];
  const q = {
    select() { return this; }, eq() { return this; }, in() { return this; },
    order() { return this; }, range() { return this; },
    then(resolve, reject) { return Promise.resolve({ data: [f.operation] }).then(resolve, reject); },
  };
  const db = { from(table) { tables.push(table); return q; } };
  const options = { db, tenantId: 'tenant', asOf: '2026-07-01' };
  const single = await resolveMemberAmendmentReadOverlay({ ...options, history: f.history });
  const batch = await resolveMemberAmendmentReadOverlaysBatched({ ...options, history: [f.history] });
  assert.equal(effectiveMemberEntitlement(single).configId, 'new');
  assert.deepEqual(batch, [single]);
  assert.deepEqual(tables, ['member_amendment_provider_operation', 'member_amendment_provider_operation']);
});
