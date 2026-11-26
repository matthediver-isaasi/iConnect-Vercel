import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolveCatalogueQuoteTax } from './salesQuoteCatalogueTax.js';
import { calculateQuoteLine } from '../../shared/salesContracts.js';
import { buildBillingSchedule } from '../../shared/salesBilling.js';

function fixture(provider = 'xero') {
  const reads = [];
  const dependencies = { getActiveAccountingProvider: async tenant => {
    assert.equal(tenant, 'tenant-a'); return provider;
  } };
  const db = { from(table) {
    assert.equal(table, 'system_settings');
    return { select() { return this; }, eq(key, value) { reads.push([key, value]); return this; },
      async maybeSingle() { return { data: { setting_value: { provider, rates: [
        { taxType: 'STANDARD', name: 'Standard VAT', effectiveRate: 20, status: 'ACTIVE', canApplyToRevenue: true },
        { taxType: 'EXEMPT', name: 'Exempt income', effectiveRate: 0, status: 'ACTIVE', canApplyToRevenue: true },
        { taxType: 'ZERO', name: 'Zero rated', effectiveRate: 0, status: 'ACTIVE', canApplyToRevenue: true },
      ] } } }; } };
  } };
  return { db, dependencies, reads };
}
for (const provider of ['xero', 'quickbooks']) {
  for (const [id, bps] of [['STANDARD', 2000], ['EXEMPT', 0], ['ZERO', 0]]) {
    test(`${provider} bundle ${id} overrides component and submitted tax and propagates to invoice lines`, async () => {
      const f = fixture(provider);
      const item = { tax_override: { provider, id, rateBps: 999 }, tax_rate_bps: 999 };
      const input = { kind: 'bundle', taxCode: { provider, id: 'IGNORED' }, taxRateBps: 999 };
      const tax = await resolveCatalogueQuoteTax(f.db, 'tenant-a', item, input, null, f.dependencies);
      assert.equal(tax.taxRateBps, bps);
      assert.equal(tax.taxCode.id, id);
      assert.ok(f.reads.some(([key, value]) => key === 'tenant_id' && value === 'tenant-a'));
      const amounts = calculateQuoteLine({ quantity: '2', quotedUnitPriceMinor: 10000, discountBps: 1000, taxRateBps: tax.taxRateBps });
      assert.equal(amounts.netMinor, 18000);
      assert.equal(amounts.taxMinor, bps ? 3600 : 0);
      const schedule = buildBillingSchedule({ lines: [{ ...amounts, kind: 'bundle', standardUnitPriceMinor: 10000,
        taxRateBps: tax.taxRateBps, catalogueSnapshot: { tax_code: tax.taxCode },
        components: [{ productSnapshot: { tax_rate_bps: 500 }, quantity: 1 }, { productSnapshot: { tax_rate_bps: 2000 }, quantity: 1 }] }],
        currency: 'GBP', recipient: {}, timezone: 'UTC', remainderPaymentTerms: { id: randomUUID(), name: '14 days', days: 14 }, newId: randomUUID });
      assert.deepEqual(schedule.groups[0].invoiceLines[0].taxCode, tax.taxCode);
      assert.equal(schedule.groups[0].invoiceLines[0].taxRateBps, bps);
      assert.equal(schedule.groups[0].taxMinor, amounts.taxMinor);
    });
  }
}
test('saved quote tax survives changed/removed bundle overrides and unavailable providers', async () => {
  const previous = { tax_rate_bps: 500, catalogue_snapshot: { tax_code: { provider: 'xero', id: 'HISTORICAL', rateBps: 500 } } };
  const neverRead = { from() { throw Error('Must not re-resolve historical tax'); } };
  const result = await resolveCatalogueQuoteTax(neverRead, 'tenant-a', { tax_override: { provider: 'xero', id: 'NEW' } },
    { kind: 'bundle' }, previous);
  assert.deepEqual(result, { taxCode: previous.catalogue_snapshot.tax_code, taxRateBps: 500 });
});
test('missing override retains legacy behavior; unavailable or wrong-provider overrides fail closed', async () => {
  const f = fixture();
  assert.deepEqual(await resolveCatalogueQuoteTax(f.db, 'tenant-a', {}, { kind: 'bundle' }, null, f.dependencies), { taxCode: null, taxRateBps: 0 });
  for (const choice of [{ provider: 'xero', id: 'MISSING' }, { provider: 'quickbooks', id: 'STANDARD' }]) {
    await assert.rejects(resolveCatalogueQuoteTax(f.db, 'tenant-a', { tax_override: choice }, { kind: 'bundle' }, null, f.dependencies),
      error => error.status === 409);
  }
});
