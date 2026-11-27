import test from 'node:test';
import assert from 'node:assert/strict';
import { readPoXeroInvoices, poAmount, poInvoiceGuard } from './pendingPoAuthority.js';

const reference = { key: 'id:invoice-1', id: 'invoice-1', number: 'SI-45027' };
const validInvoice = { InvoiceID: 'invoice-1', InvoiceNumber: 'SI-45027', Total: 375, CurrencyCode: 'GBP', Status: 'AUTHORISED' };

function dependencies({ organisation = 'xero-org', baseCurrency = 'GBP', invoice = validInvoice, responseOk = true, provider = 'xero' } = {}) {
  return {
    getProvider: async tenantId => {
      assert.equal(tenantId, 'tenant-1');
      return { name: provider, getRawAccessToken: async id => {
        assert.equal(id, 'tenant-1');
        return { accessToken: 'fixture-only', tenantId: 'xero-org' };
      } };
    },
    fetcher: async (url, { headers }) => {
      assert.equal(headers['xero-tenant-id'], 'xero-org');
      assert.match(url, /^https:\/\/api.xero.com\//);
      return { ok: responseOk, status: responseOk ? 200 : 503, json: async () => url.endsWith('/Organisation')
        ? { Organisations: [{ OrganisationID: organisation, BaseCurrency: baseCurrency }] }
        : { Invoices: invoice ? [invoice] : [] } };
    },
  };
}

test('verified provider gross is never reconstructed from discounts or local lines', async () => {
  const result = await readPoXeroInvoices('tenant-1', [reference], dependencies());
  const amount = poAmount({ storedAmount: 675, xeroLinked: true, evidence: result.get(reference.key) });
  assert.deepEqual(amount, { amount: 375, amountVerified: true, amountSource: 'xero', currency: 'GBP' });
});

test('provider, organisation, base currency and transport failures are explicit', async () => {
  for (const config of [
    { organisation: 'wrong-org' }, { baseCurrency: 'USD' }, { responseOk: false }, { provider: 'quickbooks' },
  ]) {
    await assert.rejects(readPoXeroInvoices('tenant-1', [reference], dependencies(config)));
  }
});

test('missing, mismatched and malformed invoices cannot produce a verified amount', async () => {
  for (const invoice of [
    null, { ...validInvoice, InvoiceID: 'wrong-id' }, { ...validInvoice, InvoiceNumber: 'wrong-number' },
    { ...validInvoice, Total: null }, { ...validInvoice, Total: '' }, { ...validInvoice, Total: '375' },
    { ...validInvoice, Total: NaN }, { ...validInvoice, CurrencyCode: 'USD' },
    { ...validInvoice, Status: null },
  ]) {
    const evidence = (await readPoXeroInvoices('tenant-1', [reference], dependencies({ invoice }))).get(reference.key);
    const amount = poAmount({ storedAmount: 675, xeroLinked: true, evidence });
    assert.equal(amount.amount, null);
    assert.equal(amount.amountVerified, false);
    assert.equal(poInvoiceGuard({ rowCount: 1, ...amount }).code, 'amount_unverified');
  }
});

test('number-only Xero links verify the unique invoice and zero is a legitimate gross', async () => {
  const ref = { key: 'num:SI-45027', number: 'SI-45027' };
  const evidence = (await readPoXeroInvoices('tenant-1', [ref], dependencies({ invoice: { ...validInvoice, Total: 0 } }))).get(ref.key);
  assert.equal(evidence.verified, true);
  assert.equal(poAmount({ xeroLinked: true, evidence }).amount, 0);
});

test('stored non-Xero invoices use stored amounts without provider evidence', () => {
  assert.deepEqual(poAmount({ storedAmount: 54.32, xeroLinked: false }),
    { amount: 54.32, amountVerified: true, amountSource: 'stored', currency: 'GBP' });
});
