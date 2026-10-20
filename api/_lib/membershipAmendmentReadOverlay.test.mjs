import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveMemberAmendmentReadOverlay, projectMemberAmendmentReadOverlay, effectiveMemberEntitlement,
} from './membershipAmendmentReadOverlay.js';
import { createMembershipConfigResolver } from './membershipConfigResolverCore.js';
import { shapePersistedCommitment } from '../membership/member-membership.js';
import { createMemberHistoryHandler } from '../membership/member-history.js';

function fixture() {
  const originalConfig = { id: 'old', tenant_id: 'tenant', name: 'Original structure',
    billing_period: 'annual', structure_scope_type: 'member', structure_field_id: 'field',
    structure_match_value: 'old-scope', start_mode: 'immediate', renewal_open_days: 30, renewal_grace_days: 10 };
  const target = { ...originalConfig, id: 'target', name: 'Applied structure', structure_match_value: 'applied-scope' };
  const history = {
    id: 'history', tenant_id: 'tenant', member_id: 'member', membership_source: 'personal',
    config_id: 'old', band_id: 'old-band', tier_label: 'Original tier', currency: 'GBP',
    status: 'active', payment_status: 'paid', payment_method: 'card', billing_period: 'annual',
    membership_year: '2026', term_key: 'rolling:2026', term_start_date: '2026-01-01', term_anchor_date: '2026-01-01',
    term_end_date: '2026-12-31', membership_renewal_date: '2027-01-01', term_duration_months: 12,
    final_cost: 100, total_with_vat: 120, vat_amount: 20, annual_cost: 100,
    accounting_invoice_id: 'original-invoice', accounting_invoice_number: 'INV-original',
    commitment_snapshot: { config: originalConfig, config_id: 'old', structure_name: 'Original structure', start_mode: 'immediate',
      billing_period: 'annual', payment_frequency: 'upfront', payment_method: 'card',
      amounts: { final_cost: 100, total_with_vat: 120, vat_amount: 20, currency: 'GBP' } },
  };
  const application = {
    id: 'application', amendment_id: 'amendment', tenant_id: 'tenant', member_id: 'member',
    source_record_id: 'history', effective_date: '2026-06-01', expires_on: '2027-01-01',
    created_at: '2026-06-01T12:00:00Z',
    snapshot: { sourceSnapshot: structuredClone(history), currency: 'GBP',
      targetSnapshot: { config: target, band: { id: 'target-band', config_id: 'target', tenant_id: 'tenant', label: 'Applied tier' } },
      delta: { grossMinor: 5000 } },
  };
  return { history, application, target };
}
function dbFor(application, { error = null, configs = [], history = [] } = {}) {
  const calls = [];
  return {
    calls,
    from(table) {
      const filters = {};
      calls.push({ table, filters });
      const chain = {
        select() { return chain; }, eq(k, v) { filters[k] = v; return chain; },
        in() { return chain; }, or() { return chain; }, order() { return chain; }, range() { return chain; },
        maybeSingle: async () => ({ data: table === 'member_membership_amendment_application' ? application : null, error }),
        then(resolve) {
          return Promise.resolve({ data: table === 'membership_tier_config' ? configs
            : table === 'member_membership_history' ? history : [], error: null }).then(resolve);
        },
      };
      return chain;
    },
  };
}

test('current display uses applied tier/structure but every original financial field remains unchanged', async () => {
  const { history, application } = fixture();
  const original = structuredClone(history);
  const db = dbFor(application);
  const result = await resolveMemberAmendmentReadOverlay({ db, tenantId: 'tenant', history, asOf: '2026-07-01' });
  assert.equal(result.effective_config_id, 'target');
  assert.equal(effectiveMemberEntitlement(result).tierLabel, 'Applied tier');
  const shape = shapePersistedCommitment(result, new Date('2026-07-01'));
  assert.equal(shape.structureName, 'Applied structure');
  assert.equal(shape.tierLabel, 'Applied tier');
  assert.equal(shape.structureId, 'target');
  assert.equal(shape.agreedPrice, 120);
  assert.equal(shape.agreedNetPrice, 100);
  for (const key of Object.keys(original)) assert.deepEqual(result[key], original[key], key);
  assert.deepEqual(history, original);
  assert.deepEqual(db.calls[0].filters, { tenant_id: 'tenant', member_id: 'member', source_record_id: 'history' });
});

test('historical evidence survives expiry without extending entitlement', () => {
  const { history, application } = fixture();
  const result = projectMemberAmendmentReadOverlay(history, application, { tenantId: 'tenant', asOf: '2027-01-01' });
  assert.equal(result.effective_config_id, undefined);
  assert.equal(result.membership_amendment_evidence[0].amendmentId, 'amendment');
  assert.equal(result.term_end_date, '2026-12-31');
});

test('no future-dated change is promoted early', () => {
  const { history, application } = fixture();
  const result = projectMemberAmendmentReadOverlay(history, application, { tenantId: 'tenant', asOf: '2026-05-31' });
  assert.equal(result.effective_config_id, undefined);
});

test('rolling successor uses final applied purchased scope even after predecessor expires', async () => {
  const { history, application, target } = fixture();
  const db = dbFor(application, { configs: [
    { ...target, id: 'successor-target' },
    { ...history.commitment_snapshot.config, id: 'successor-old' },
  ] });
  const { resolveRollingSuccessorConfig } = createMembershipConfigResolver(db);
  const config = await resolveRollingSuccessorConfig(db, { tenantId: 'tenant', previousTerm: history });
  assert.equal(config.id, 'successor-target');
  assert.equal(history.config_id, 'old');
  assert.equal(history.accounting_invoice_id, 'original-invoice');
});

test('organisation and monthly paths are untouched and do not query personal amendments', async () => {
  const { history } = fixture();
  const db = { from() { throw new Error('must not query'); } };
  for (const row of [
    { ...history, membership_source: 'organisation', organization_id: 'org' },
    { ...history, billing_agreement_id: 'agreement' },
    { ...history, commitment_snapshot: { ...history.commitment_snapshot, payment_frequency: 'monthly' } },
  ]) assert.equal(await resolveMemberAmendmentReadOverlay({ db, tenantId: 'tenant', history: row }), row);
});

test('missing migration alone permits original display; permission/connectivity failures fail closed', async () => {
  const { history } = fixture();
  assert.equal(await resolveMemberAmendmentReadOverlay({
    db: dbFor(null, { error: { code: '42P01' } }), tenantId: 'tenant', history,
  }), history);
  for (const code of ['42501', '42703', 'PGRST116', 'network']) {
    await assert.rejects(resolveMemberAmendmentReadOverlay({
      db: dbFor(null, { error: { code } }), tenantId: 'tenant', history,
    }), error => error.code === 'amendment_overlay_unavailable');
  }
});

test('cross-tenant/member/source or term mismatch never silently falls back to original scope', async () => {
  for (const [key, value] of [['tenant_id', 'other'], ['member_id', 'other'], ['source_record_id', 'other'], ['expires_on', '2028-01-01']]) {
    const { history, application } = fixture();
    application[key] = value;
    await assert.rejects(resolveMemberAmendmentReadOverlay({
      db: dbFor(application), tenantId: 'tenant', history,
    }), error => error.code === 'amendment_overlay_invalid');
  }
});

test('member-history appends explicit application evidence without rewriting invoice amounts or original labels', async () => {
  const { history, application } = fixture();
  const db = dbFor(application, { history: [history] });
  const handler = createMemberHistoryHandler({
    db, getSessionMember: async () => ({ id: 'member', tenant_id: 'tenant' }),
    getTenantContext: async () => ({ isAuthenticated: true, tenantId: 'tenant' }),
    hasAdminAccess: async () => true, enrichMembershipHistoryPrices: async () => {},
  });
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(payload) { this.payload = payload; return payload; } };
  await handler({ method: 'GET' }, res);
  assert.equal(res.statusCode, 200);
  const row = res.payload[0];
  assert.equal(row.membership_amendment_evidence[0].targetTierLabel, 'Applied tier');
  assert.equal(row.tier_label, 'Original tier');
  assert.equal(row.total_with_vat, 120);
  assert.equal(row.accounting_invoice_id, 'original-invoice');
});
