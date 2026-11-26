import test from 'node:test';
import assert from 'node:assert/strict';
import { salesTicketPricing } from './salesTicketPricing.js';
import { listSalesTicketEventOptions } from './salesTicketEventOptions.js';

const taxOptions = { provider: 'xero', items: [{ id: 'OUTPUT2', name: 'Standard 20%', rateBps: 2000, selectable: true }] };

test('ticket pricing converts VAT-inclusive prices to net and maps VAT to a synced provider code', () => {
  const pricing = salesTicketPricing({ id: 't', price: 120, vat_rate_key: 'OUTPUT2', vat_rate_percentage: 20 }, { currency: 'GBP', taxOptions });
  assert.equal(pricing.grossUnitPriceMinor, 12000);
  assert.equal(pricing.unitPriceMinor, 10000);
  assert.deepEqual(pricing.taxCode, { provider: 'xero', id: 'OUTPUT2', name: 'Standard 20%', rateBps: 2000 });
  assert.equal(pricing.taxCodeRequired, false);
  const unmatched = salesTicketPricing({ id: 't', price: 50, vat_rate_key: 'OLD', vat_rate_percentage: 0 }, { taxOptions });
  assert.equal(unmatched.unitPriceMinor, 5000);
  assert.equal(unmatched.taxCode, null);
  assert.equal(unmatched.taxCodeRequired, true);
  const noProvider = salesTicketPricing({ id: 't', price: 50, vat_rate_key: 'OLD', vat_rate_percentage: 5 }, { taxOptions: null });
  assert.equal(noProvider.taxCodeRequired, false);
  assert.equal(noProvider.taxRateBps, 500);
  assert.match(salesTicketPricing({ id: 't', price: 50, currency: 'eur' }, { currency: 'GBP' }).priceUnavailableReason, /priced in EUR/);
  assert.equal(salesTicketPricing({ id: 't', price: 50, is_free: true }, {}).unitPriceMinor, 0);
});

test('active early bird price is used; expired early bird falls back to the standard price', () => {
  const future = new Date(Date.now() + 86400000).toISOString();
  const past = new Date(Date.now() - 86400000).toISOString();
  const early = salesTicketPricing({ id: 't', price: 100, early_bird_enabled: true, early_bird_price: 80, early_bird_deadline: future }, {});
  assert.equal(early.unitPriceMinor, 8000);
  assert.equal(early.isEarlyBird, true);
  const expired = salesTicketPricing({ id: 't', price: 100, early_bird_enabled: true, early_bird_price: 80, early_bird_deadline: past }, {});
  assert.equal(expired.unitPriceMinor, 10000);
  assert.equal(expired.isEarlyBird, false);
});

test('Sales ticket discovery adds price and VAT for simple and complex ticket options when requested', async () => {
  const simpleId = '00000000-0000-4000-8000-000000000001';
  const complexId = '00000000-0000-4000-8000-000000000002';
  const items = [
    { id: simpleId, kind: 'simple', ticketOptions: [{ id: 'standard' }] },
    { id: complexId, kind: 'complex', ticketOptions: [{ id: 'c1' }, { id: 'missing' }] },
  ];
  const tables = {
    event: [{ id: simpleId, pricing_config: JSON.stringify({ ticket_classes: [{ id: 'standard', price: 60, vat_rate_percentage: 20 }] }) }],
    complex_event_ticket_class: [{ id: 'c1', complex_event_id: complexId, price: 30 }],
  };
  const db = {
    rpc: async () => ({ data: { items } }),
    from(table) {
      return { select() { return this; }, eq() { return this; }, in: async () => ({ data: tables[table] }) };
    },
  };
  const plain = await listSalesTicketEventOptions(db, 'tenant', {});
  assert.equal(plain.items[0].ticketOptions[0].unitPriceMinor, undefined);
  const result = await listSalesTicketEventOptions(db, 'tenant', { withPricing: true, currency: 'gbp',
    dependencies: { getActiveAccountingProvider: async () => 'none' } });
  assert.equal(result.items[0].ticketOptions[0].unitPriceMinor, 5000);
  assert.equal(result.items[0].ticketOptions[0].taxRateBps, 2000);
  assert.equal(result.items[1].ticketOptions[0].unitPriceMinor, 3000);
  assert.equal(result.items[1].ticketOptions[1].unitPriceMinor, null);
  assert.match(result.items[1].ticketOptions[1].priceUnavailableReason, /could not be loaded/);
});
