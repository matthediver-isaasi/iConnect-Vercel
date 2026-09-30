import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Execute the actual adapter functions with strictly mocked transport/token
// seams. No database, token refresh, fetch, or financial operation runs.
function harness({ preferences, explicitCurrency, existing = false, preferencesFailure = false } = {}) {
  const source = readFileSync(new URL('./quickbooks.js', import.meta.url), 'utf8');
  const section = source.slice(source.indexOf('export async function createQuickBooksCreditNote('),
    source.indexOf('// PO push', source.indexOf('export async function createQuickBooksCreditNote('))).replaceAll('export async function', 'async function');
  const calls = [];
  const note = { Id: '44', TotalAmt: 20, ...(explicitCurrency ? { CurrencyRef: { value: explicitCurrency } } : {}) };
  const qboFetch = async (context, token, method, url) => {
    calls.push({ context, token, method, url });
    if (context === 'preferences-retrieve') {
      if (preferencesFailure) throw new Error('Preferences read failed');
      return { Preferences: { CurrencyPrefs: preferences } };
    }
    if (context === 'invoice-retrieve') return { Invoice: { Id: '11', TotalAmt: 20, Balance: 0, CustomerRef: { value: 'customer' },
      Line: [{ DetailType: 'SalesItemLineDetail', SalesItemLineDetail: { ItemRef: { value: 'item' }, TaxCodeRef: { value: 'tax' } } }] } };
    if (context === 'creditmemo-create') return { CreditMemo: note };
    throw new Error(`Unexpected mocked operation: ${context}`);
  };
  const qboQuery = async (token, realm, environment, query) => {
    calls.push({ context: 'query', method: 'GET', query, realm });
    return { QueryResponse: { CreditMemo: query.includes('WHERE Id') || existing ? [note] : [] } };
  };
  const adapter = new Function('getValidQuickBooksAccessToken', 'getIntuitEndpoints', 'companyBase', 'MINOR_VERSION', 'qboFetch', 'qboQuery',
    `${section}; return { createQuickBooksCreditNote, readQuickBooksCreditNoteEvidence, resolveQuickBooksCreditCurrency };`)(
    async tenant => { assert.equal(tenant, 'tenant'); return { accessToken: 'mock-token', realmId: 'mock-realm', environment: 'sandbox' }; },
    () => ({ apiBaseUrl: 'https://mock.invalid' }), (base, realm) => `${base}/company/${realm}`, '75', qboFetch, qboQuery,
  );
  return { adapter, calls };
}

test('single-currency creation and duplicate recovery use authoritative Preferences home currency', async () => {
  for (const existing of [false, true]) {
    const { adapter, calls } = harness({ existing, preferences: { MultiCurrencyEnabled: false, HomeCurrency: { value: 'CAD' } } });
    const result = await adapter.createQuickBooksCreditNote({ appTenantId: 'tenant', invoiceId: '11', creditAmount: 20, reference: 'mock-reference' });
    assert.equal(result.currency, 'CAD');
    assert.equal(result.amount, 20);
    const preferences = calls.filter(call => call.context === 'preferences-retrieve');
    assert.equal(preferences.length, 1);
    assert.equal(preferences[0].method, 'GET');
    assert.match(preferences[0].url, /company\/mock-realm\/preferences/);
    assert.equal(calls.filter(call => call.context === 'creditmemo-create').length, existing ? 0 : 1);
  }
});
test('read-only note recovery uses home currency without any provider write', async () => {
  const { adapter, calls } = harness({ preferences: { MultiCurrencyEnabled: false, HomeCurrency: { value: 'AUD' } } });
  const result = await adapter.readQuickBooksCreditNoteEvidence('tenant', '44');
  assert.equal(result.currency, 'AUD');
  assert.equal(result.providerId, '44');
  assert.ok(calls.every(call => call.method === 'GET'));
});
test('explicit memo currency needs no home-currency lookup', async () => {
  const { adapter, calls } = harness({ explicitCurrency: 'eur' });
  assert.equal((await adapter.readQuickBooksCreditNoteEvidence('tenant', '44')).currency, 'EUR');
  assert.equal(calls.length, 1);
});
test('missing/ambiguous Preferences and read failures never invent GBP', async () => {
  for (const options of [
    {}, { preferences: { MultiCurrencyEnabled: true, HomeCurrency: { value: 'GBP' } } },
    { preferences: { MultiCurrencyEnabled: false } }, { preferencesFailure: true },
  ]) {
    const { adapter, calls } = harness(options);
    await assert.rejects(adapter.readQuickBooksCreditNoteEvidence('tenant', '44'), /currency unavailable|Preferences read failed/);
    assert.ok(calls.every(call => call.method === 'GET'));
  }
});