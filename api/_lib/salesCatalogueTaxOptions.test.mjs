import test from 'node:test';
import assert from 'node:assert/strict';
import { listCatalogueTaxOptions } from './salesCatalogueTaxOptions.js';
import { createCatalogueTaxOptionsHandler } from '../sales/catalogue/tax-options.js';

const rate = (taxType, effectiveRate, name = taxType, extra = {}) => ({
  taxType, effectiveRate, name, status: 'ACTIVE', canApplyToRevenue: true, ...extra,
});
function fixture({ provider = 'xero', snapshot = { rates: [
  rate('OUTPUT2', 20, '20% VAT on Income'), rate('ZERORATED', 0), rate('EXEMPT', 0),
  rate('INPUT2', 20, 'Purchase VAT', { canApplyToRevenue: false }),
  rate('OLD', 5, 'Old VAT', { status: 'DELETED' }), rate('MISSING', null),
  rate('BAD', 'bad'), rate('TOO_PRECISE', 5.123), rate('BOOLEAN', true), rate('BLANK', ' '),
], syncedAt: '2026-10-09T00:00:00Z' }, failure = false, authorized = true } = {}) {
  const reads = [];
  const db = { from(table) {
    const filters = [];
    reads.push({ table, filters });
    const result = () => failure ? { error: new Error('private database details') }
      : { data: table === 'system_settings' ? { setting_value: typeof snapshot === 'string' ? snapshot : JSON.stringify(snapshot) }
        : [{ tax_rate_bps: 2000, provider_tax_code: 'OUTPUT2' }, { tax_rate_bps: 0, provider_tax_code: 'ZERORATED' }] };
    const q = {
      select() { return q; }, eq(...args) { filters.push(args); return q; },
      async maybeSingle() { return result(); },
      then(resolve, reject) { return Promise.resolve(result()).then(resolve, reject); },
    };
    return q;
  } };
  return { db, reads, getActiveAccountingProvider: async () => provider,
    getTenantContext: async () => ({ isAuthenticated: true, tenantId: 'tenant-a', memberId: 'actor', roleId: 'sales' }),
    hasFeatureAccess: async () => authorized };
}

test('reads synced revenue codes only and allows only exact configured Sales mappings', async () => {
  const f = fixture();
  const result = await listCatalogueTaxOptions(f.db, 'tenant-a', f);
  assert.equal(result.items.length, 3);
  assert.equal(result.items.find(r => r.id === 'OUTPUT2').rateBps, 2000);
  assert.equal(result.items.find(r => r.id === 'OUTPUT2').selectable, true);
  assert.equal(result.items.find(r => r.id === 'ZERORATED').selectable, true);
  assert.equal(result.items.find(r => r.id === 'EXEMPT').selectable, false);
  for (const read of f.reads) assert.ok(read.filters.some(([key, value]) => key === 'tenant_id' && value === 'tenant-a'));
  assert.ok(f.reads[1].filters.some(([key, value]) => key === 'provider' && value === 'xero'));
});
test('rejects missing, malformed or wrong-provider snapshots instead of falling back to zero tax', async () => {
  for (const options of [{ provider: 'none' }, { snapshot: null }, { snapshot: '{bad' },
    { provider: 'quickbooks' }, { snapshot: { provider: 'quickbooks', rates: [] } }]) {
    const f = fixture(options);
    await assert.rejects(listCatalogueTaxOptions(f.db, 'tenant-a', f), e => e.status === 409);
  }
  const f = fixture({ provider: 'quickbooks', snapshot: { provider: 'quickbooks', rates: [rate('OUTPUT2', 20)] } });
  assert.equal((await listCatalogueTaxOptions(f.db, 'tenant-a', f)).items[0].selectable, true);
});
test('dedicated URL-only route enforces Sales catalogue permission and does not expose database errors', async () => {
  const run = async (f, method = 'GET') => {
    const res = { statusCode: 200, setHeader() {}, status(code) { this.statusCode = code; return this; },
      json(data) { this.body = data; return this; } };
    await createCatalogueTaxOptionsHandler(f)({ method, url: '/api/sales/catalogue/tax-options' }, res);
    return res;
  };
  assert.equal((await run(fixture())).statusCode, 200);
  const denied = fixture({ authorized: false });
  assert.equal((await run(denied)).statusCode, 403);
  assert.equal(denied.reads.length, 0);
  assert.equal((await run(fixture(), 'POST')).statusCode, 405);
  const failed = await run(fixture({ failure: true }));
  assert.equal(failed.statusCode, 500);
  assert.ok(!failed.body.error.includes('private'));
});
