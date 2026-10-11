import test from 'node:test';
import assert from 'node:assert/strict';
import { quoteSalespersonOptions, quoteSalespersonSnapshot } from './quoteSalespeople.js';
import { normaliseQuoteInput } from '../../shared/salesContracts.js';
import { SALES_CAPABILITIES } from '../../shared/salesContracts.js';
import { createSalesQuotesHandler } from '../sales/quotes/[...path].js';
import { saveQuoteDraft } from './salesQuote.js';

function fixture() {
  const rows = [
    { id: 'team', tenant_id: 'tenant', organization_id: 'primary', first_name: 'Alex', email: 'alex@example.test' },
    { id: 'foreign', tenant_id: 'other', organization_id: 'primary' },
    { id: 'customer', tenant_id: 'tenant', organization_id: 'customer' },
    { id: 'deleted', tenant_id: 'tenant', organization_id: 'primary', email: 'deleted_old@deleted.local' },
  ];
  return { from(table) {
    const filters = []; let single = false; let start = 0; let end = 99;
    const q = {
      select() { return q; }, eq(k, v) { filters.push(row => row[k] === v); return q; },
      or() { filters.push(row => !row.email?.startsWith('deleted_')); return q; },
      order() { return q; }, range(a, b) { start = a; end = b; return q; },
      maybeSingle() { single = true; return q; },
      then(resolve) {
        const data = (table === 'organization' ? [{ id: 'primary', tenant_id: 'tenant', is_primary: true }] : rows).filter(row => filters.every(f => f(row)));
        resolve({ data: single ? data[0] || null : data.slice(start, end + 1), error: null });
      },
    };
    return q;
  } };
}

test('options include only primary-organisation colleagues in this tenant', async () => {
  assert.deepEqual((await quoteSalespersonOptions(fixture(), 'tenant')).items.map(p => p.id), ['team']);
  await assert.rejects(quoteSalespersonOptions(fixture(), 'tenant', '-1'), { status: 400 });
});
test('new selections reject foreign, customer, deleted and missing members', async () => {
  for (const salespersonId of ['foreign', 'customer', 'deleted', 'missing']) {
    await assert.rejects(quoteSalespersonSnapshot(fixture(), 'tenant', {}, { salespersonId }), { status: 400 });
  }
  assert.equal((await quoteSalespersonSnapshot(fixture(), 'tenant', {}, { salespersonId: 'team' })).first_name, 'Alex');
});
test('persisted snapshots survive unchanged without looking up departed people; clear is explicit', async () => {
  const db = { from() { throw new Error('Unexpected lookup'); } };
  const previous = { id: 'departed', first_name: 'Original' };
  assert.equal(await quoteSalespersonSnapshot(db, 'tenant', {}, { salespersonId: 'departed' }, previous), previous);
  const cleared = normaliseQuoteInput({ salespersonId: null });
  assert.equal(await quoteSalespersonSnapshot(db, 'tenant', {}, cleared, previous), null);
  assert.deepEqual(await quoteSalespersonSnapshot(db, 'tenant', { actorId: 'actor', actorType: 'tenant_user' }, {}), { id: 'actor', type: 'tenant_user' });
});
test('options require authenticated tenant Sales and quote-management access', async () => {
  for (const context of [
    {}, { isAuthenticated: true, tenantId: 'tenant', memberId: 'member', roleId: 'role' },
    { isAuthenticated: true, tenantId: 'tenant', tenantUserId: 'admin', tenantMismatch: true },
  ]) {
    const handler = createSalesQuotesHandler({
      db: { from() { throw new Error('Must deny before discovery'); } },
      getTenantContext: async () => context, hasFeatureAccess: async (_role, capability) => capability === SALES_CAPABILITIES.VIEW,
    });
    const res = { status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
    await handler({ method: 'GET', query: { action: 'salesperson-options' } }, res);
    assert.ok([401, 403, 409].includes(res.code));
  }
});

test('save and preview handlers preserve ineligible historical salespeople, including override preflight', async () => {
  const salespersonId = '123e4567-e89b-12d3-a456-426614174000';
  const lineId = '123e4567-e89b-12d3-a456-426614174001';
  const previous = { id: salespersonId, first_name: 'Original Name', type: 'tenant_user' };
  let payload;
  const scopes = [];
  const db = {
    from(table) {
      assert.ok(['sales_quote_version', 'sales_quote_line', 'sales_settings'].includes(table), 'Must not look up historical salesperson');
      const q = {
        select() { return q; }, eq(key, value) { if (key === 'tenant_id') scopes.push(value); return q; },
        maybeSingle() { return q; },
        then(resolve) { resolve({ data: table === 'sales_quote_version' ? { id: 'version', salesperson_snapshot: previous } : table === 'sales_settings' ? {} : [{ id: lineId, catalogue_kind: 'free_text', tax_rate_bps: 0 }], error: null }); },
      };
      return q;
    },
    async rpc(_name, args) { payload = args.p_payload; return { data: { id: 'quote' }, error: null }; },
  };
  const body = { expectedVersion: 1, currency: 'GBP', salespersonId, notes: 'Unrelated edit', lines: [{ id: lineId, kind: 'free_text', description: 'Existing item', quantity: '1', standardUnitPriceMinor: 100, quotedUnitPriceMinor: 100 }] };
  await saveQuoteDraft(db, 'tenant', { actorId: 'actor' }, 'quote', 1, body, false);
  assert.deepEqual(payload.salespersonSnapshot, previous);
  const handler = createSalesQuotesHandler({ db, getTenantContext: async () => ({
    isAuthenticated: true, tenantId: 'tenant', tenantUserId: 'actor',
  }) });
  for (const override of [false, true]) {
    const requestBody = { ...body, lines: [{ ...body.lines[0], quotedUnitPriceMinor: override ? 90 : 100 }] };
    for (const method of ['POST', 'PATCH']) {
      const res = { status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
      await handler({ method, query: { id: 'quote', ...(method === 'POST' ? { action: 'preview' } : {}) }, body: requestBody }, res);
      assert.equal(res.code, 200, JSON.stringify(res.body));
      assert.deepEqual(method === 'POST' ? res.body.quote.salespersonSnapshot : payload.salespersonSnapshot, previous);
    }
  }
  assert.ok(scopes.length >= 3 && scopes.every(value => value === 'tenant'));
});
