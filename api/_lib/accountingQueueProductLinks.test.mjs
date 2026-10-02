import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { linkAccountingProductSource } from './accountingQueueProductLinks.js';

function database(tables) {
  const writes = [];
  return { writes, from(table) {
    const filters = [];
    let update;
    const query = {
      select() { return query; },
      eq(key, value) { filters.push(record => record[key] === value); return query; },
      is(key, value) { filters.push(record => (record[key] ?? null) === value); return query; },
      update(value) { update = value; return query; },
      async maybeSingle() { return execute(true); },
      then(resolve, reject) { return Promise.resolve(execute(false)).then(resolve, reject); },
    };
    function execute(one) {
      const matches = (tables[table] || []).filter(record => filters.every(filter => filter(record)));
      if (update) {
        writes.push({ table, update });
        for (const match of matches) Object.assign(match, update);
      }
      return { data: one ? matches[0] || null : matches, error: null };
    }
    return query;
  } };
}

const purchaseRow = (provider = 'xero') => ({
  tenant_id: 'tenant', source_type: 'training_fund_purchase', source_id: 'purchase',
  provider, invoice_result: { id: 'invoice', invoiceNumber: 'INV-1' },
  snapshot: { linkage: { purchaseId: 'purchase', organizationId: 'org' } },
});

for (const provider of ['xero', 'quickbooks']) {
  test(`${provider} purchase linkage is tenant scoped, repeatable and accounting-only`, async () => {
    const purchase = { tenant_id: 'tenant', id: 'purchase', organization_id: 'org', status: 'pending' };
    const db = database({ training_fund_purchase: [purchase] });
    assert.equal((await linkAccountingProductSource({ db, row: purchaseRow(provider) })).linked, true);
    await linkAccountingProductSource({ db, row: purchaseRow(provider) });
    assert.equal(db.writes.length, 1);
    assert.equal(purchase.accounting_provider, provider);
    assert.equal(purchase.status, 'pending');
    assert.equal(purchase.accounting_invoice_id, 'invoice');
    assert.equal(purchase.xero_invoice_id, provider === 'xero' ? 'invoice' : undefined);
    assert.ok(Object.keys(db.writes[0].update).every(key =>
      key.startsWith('accounting_') || key.startsWith('xero_') || key === 'online_invoice_url'));
  });
}

test('conflicting invoice cannot overwrite a purchase', async () => {
  const db = database({ training_fund_purchase: [{
    tenant_id: 'tenant', id: 'purchase', organization_id: 'org', accounting_invoice_id: 'other',
  }] });
  await assert.rejects(linkAccountingProductSource({ db, row: purchaseRow() }), /different invoice/);
  assert.equal(db.writes.length, 0);
});

test('foreign-tenant purchase and spoofed source are rejected', async () => {
  const db = database({ training_fund_purchase: [{ tenant_id: 'foreign', id: 'purchase', organization_id: 'org' }] });
  await assert.rejects(linkAccountingProductSource({ db, row: purchaseRow() }), /not found/);
  const row = purchaseRow();
  row.snapshot.linkage.purchaseId = 'another';
  await assert.rejects(linkAccountingProductSource({ db, row }), /invalid purchase authority/);
  assert.equal(db.writes.length, 0);
});

test('sales linkage rejects a conflicting provider invoice without completing claim', async () => {
  const db = database({
    sales_commercial_sale: [{ tenant_id: 'tenant', id: 'sale', quote_version_id: 'version' }],
    sales_accounting_invoice_attempt: [{ tenant_id: 'tenant', id: 'attempt', sale_id: 'sale', provider: 'xero' }],
    sales_accounting_invoice_link: [{ tenant_id: 'tenant', sale_id: 'sale', provider: 'xero',
      quote_version_id: 'version', provider_invoice_id: 'other' }],
  });
  const row = { tenant_id: 'tenant', source_type: 'sales_commercial_sale', source_id: 'sale',
    provider: 'xero', invoice_result: { id: 'invoice' },
    snapshot: { linkage: { saleId: 'sale', quoteVersionId: 'version', attemptId: 'attempt', actorId: 'admin' } } };
  await assert.rejects(linkAccountingProductSource({ db, row }), /different source/);
  assert.equal(db.writes.length, 0);
});

test('OFF rollout preserves producers and card accounting while legacy endpoint requires admin authority', () => {
  const source = readFileSync(new URL('../functions/[functionName].js', import.meta.url), 'utf8');
  const purchase = source.slice(source.indexOf('async createTrainingFundPurchase('), source.indexOf('async confirmTrainingFundPurchasePayment('));
  assert.ok(!purchase.includes('requireProductAccountingQueue'));
  assert.ok(!purchase.includes('.delete()'));
  const legacy = source.slice(source.indexOf('async createXeroInvoice('), source.indexOf('async updateXeroInvoicePO('));
  assert.ok(legacy.indexOf('hasAdminAccess(context)') < legacy.indexOf('getValidXeroAccessToken('));
  const confirm = source.slice(source.indexOf('async confirmTrainingFundPurchasePayment('), source.indexOf('async refreshMemberBalance('));
  assert.ok(confirm.includes('applyStripePaymentToInvoice('));
  assert.ok(!confirm.includes('paymentIntents.create('));
  assert.ok(confirm.includes('creditTrainingFundForPurchase('));
});