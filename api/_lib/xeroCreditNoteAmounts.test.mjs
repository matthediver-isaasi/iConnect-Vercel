import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { buildXeroCreditAmounts, assertXeroCreditTotal } from './xeroCreditNoteAmounts.js';

const invoice = (basis = 'Inclusive') => ({
  InvoiceID: 'invoice', InvoiceNumber: 'INV-8955', Status: 'AUTHORISED',
  Contact: { ContactID: 'contact' }, CurrencyCode: 'GBP',
  LineAmountTypes: basis, Total: 200, TotalTax: 33.33, AmountDue: 200, AmountCredited: 0,
  LineItems: [{ Description: 'Ticket', Quantity: 1, UnitAmount: basis === 'Inclusive' ? 200 : 166.67,
    LineAmount: basis === 'Inclusive' ? 200 : 166.67, TaxAmount: 33.33, TaxType: 'OUTPUT2', AccountCode: '210' }],
});

for (const basis of ['Inclusive', 'Exclusive']) {
  test(`${basis} £200 invoice produces £200 gross credit with £33.33 VAT`, () => {
    const result = buildXeroCreditAmounts(invoice(basis), 200);
    assert.equal(result.LineAmountTypes, 'Inclusive');
    assert.equal(result.CurrencyCode, 'GBP');
    assert.equal(result.LineItems[0].UnitAmount, 200);
    assert.equal(result.LineItems[0].TaxAmount, 33.33);
    assert.equal(result.LineItems[0].TaxType, 'OUTPUT2');
  });
  test(`${basis} partial £100 credit contains £16.67 VAT`, () => {
    const result = buildXeroCreditAmounts(invoice(basis), 100);
    assert.equal(result.LineItems[0].UnitAmount, 100);
    assert.equal(result.LineItems[0].TaxAmount, 16.67);
  });
}

test('tax-free original invoice stays tax-free', () => {
  const original = invoice('NoTax');
  original.TotalTax = 0;
  Object.assign(original.LineItems[0], { LineAmount: 200, TaxAmount: 0, TaxType: 'NONE' });
  assert.equal(buildXeroCreditAmounts(original, 100).LineItems[0].TaxAmount, 0);
});

test('full mixed-tax credit retains both original lines; partial mixed-tax credit fails closed', () => {
  const original = invoice();
  original.Total = 250;
  original.LineItems.push({ LineAmount: 50, TaxAmount: 0, TaxType: 'NONE', AccountCode: '210' });
  const lines = buildXeroCreditAmounts(original, 250).LineItems;
  assert.deepEqual(lines.map(l => [l.UnitAmount, l.TaxAmount, l.TaxType]),
    [[200, 33.33, 'OUTPUT2'], [50, 0, 'NONE']]);
  assert.throws(() => buildXeroCreditAmounts(original, 100), /original line allocation/);
});

test('partial credit refuses to guess between distinct accounting codes', () => {
  const original = invoice();
  original.Total = 400; original.TotalTax = 66.66;
  original.LineItems.push({ ...original.LineItems[0], AccountCode: '220' });
  assert.throws(() => buildXeroCreditAmounts(original, 200), /original line allocation/);
});

test('missing or inconsistent evidence cannot create a credit', () => {
  for (const change of [
    { Total: 201 }, { TotalTax: 40 }, { CurrencyCode: null },
    { LineAmountTypes: null }, { LineItems: [] },
    { LineItems: [{ ...invoice().LineItems[0], TaxType: null }] },
    { LineItems: [{ ...invoice().LineItems[0], LineAmount: -200 }] },
  ]) assert.throws(() => buildXeroCreditAmounts({ ...invoice(), ...change }, 200), /needs review/);
  assert.throws(() => buildXeroCreditAmounts(invoice(), 240), /exceeds/);
});

test('provider totals and VAT are verified before allocation', () => {
  assert.doesNotThrow(() => assertXeroCreditTotal({ Total: 200, TotalTax: 33.33, CurrencyCode: 'GBP' }, 200, 'GBP', 33.33));
  for (const change of [{ Total: 240 }, { TotalTax: 40 }, { CurrencyCode: 'EUR' }, { HasErrors: true }]) {
    assert.throws(() => assertXeroCreditTotal({ Total: 200, TotalTax: 33.33, CurrencyCode: 'GBP', ...change }, 200, 'GBP', 33.33), /needs review/);
  }
});

const source = readFileSync(new URL('./xero.js', import.meta.url), 'utf8');
const functionSource = source.slice(source.indexOf('export async function createXeroCreditNote('),
  source.indexOf('export async function readXeroInvoiceCreditEvidence(')).replace('export ', '');
async function run({ original = invoice(), responseTotal = 200, existing = [], amount = 200 } = {}) {
  const calls = [];
  const context = vm.createContext({
    buildXeroCreditAmounts, assertXeroCreditTotal,
    console: { log() {}, warn() {} },
    getValidXeroAccessToken: async () => ({ accessToken: 'fixture', tenantId: 'fixture' }),
    safeXeroJson: async response => response,
    fetch: async (url, options) => {
      const body = options.body ? JSON.parse(options.body) : null;
      calls.push({ url, method: options.method, body });
      if (options.method === 'GET') return url.includes('/Invoices/')
        ? { Invoices: [original] } : { CreditNotes: existing };
      if (options.method === 'PUT') return { Allocations: [{}] };
      return { CreditNotes: [{ CreditNoteID: 'credit', CreditNoteNumber: 'CN-test',
        Total: responseTotal, TotalTax: body.CreditNotes[0].LineItems.reduce((s, l) => s + l.TaxAmount, 0),
        CurrencyCode: 'GBP', Status: 'AUTHORISED' }] };
    },
  });
  vm.runInContext(functionSource, context);
  try {
    const result = await context.createXeroCreditNote({ appTenantId: 'tenant', invoiceId: 'invoice',
      creditAmount: amount, reference: 'Cancel: fixture' });
    return { result, calls };
  } catch (error) { return { error, calls }; }
}

test('actual cancellation writer sends inclusive payload and allocates only £200', async () => {
  const { result, calls, error } = await run();
  assert.equal(error, undefined);
  assert.equal(result.amount, 200);
  const payload = calls.find(c => c.method === 'POST').body.CreditNotes[0];
  assert.equal(payload.LineAmountTypes, 'Inclusive');
  assert.equal(payload.LineItems[0].UnitAmount, 200);
  assert.equal(payload.LineItems[0].TaxAmount, 33.33);
  assert.equal(calls.find(c => c.method === 'PUT').body.Allocations[0].Amount, 200);
});

test('incorrect provider total is not allocated or reported as success', async () => {
  const { error, calls } = await run({ responseTotal: 240 });
  assert.match(error.message, /needs review/);
  assert.equal(calls.some(c => c.method === 'PUT'), false);
});

test('existing over-credit is flagged without creating another credit', async () => {
  const { error, calls } = await run({ existing: [{ Status: 'AUTHORISED', Total: 240 }] });
  assert.match(error.message, /exceeds/);
  assert.equal(calls.some(c => c.method !== 'GET'), false);
});

test('remaining gross credit cap is retained', async () => {
  const { result, calls, error } = await run({ original: { ...invoice(), AmountCredited: 100, AmountDue: 100 }, responseTotal: 100 });
  assert.equal(error, undefined);
  assert.equal(result.amount, 100);
  assert.equal(calls.find(c => c.method === 'POST').body.CreditNotes[0].LineItems[0].TaxAmount, 16.67);
});

test('ambiguous partial mixed-tax invoice makes no financial requests', async () => {
  const original = invoice();
  original.Total = 250;
  original.LineItems.push({ LineAmount: 50, TaxAmount: 0, TaxType: 'NONE', AccountCode: '210' });
  const { error, calls } = await run({ original, amount: 100 });
  assert.match(error.message, /original line allocation/);
  assert.equal(calls.some(c => c.method !== 'GET'), false);
});
