import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  isGrossSnapshotUnavailable, registrationTicketPricePresentation, registrationDiscountPresentation,
  registrationTicketPriceExport, registrationDiscountExport, registrationPricePaidPresentation,
} from './eventRegistrationRecordedFinancial.js';
import { financialAmount } from './eventRegistrationFinancial.js';

const legacy = {
  payment_method: 'public_invoice_po', ticket_price_status: 'unavailable_gross_snapshot',
  ticket_price: null, raw_ticket_price: 166.67,
};
const payment = { totalsStatus: 'unavailable_gross_snapshot', discount: null, codeDiscount: 0 };

test('legacy Invoice / PO exposes only recorded after-offer price without changing canonical data', () => {
  const original = structuredClone(legacy);
  assert.deepEqual(registrationTicketPricePresentation(legacy), { amount: 166.67, recorded: true });
  assert.match(registrationTicketPriceExport(legacy), /166.67.*recorded after offers; original list price unavailable/);
  assert.deepEqual(legacy, original);
  for (const raw_ticket_price of [null, undefined, '', 'invalid', Infinity]) {
    assert.equal(registrationTicketPriceExport({ ...legacy, raw_ticket_price }), 'Unavailable');
  }
  assert.deepEqual(registrationTicketPricePresentation({ ...legacy, raw_ticket_price: 0 }), { amount: 0, recorded: true });
});

test('recorded ticket fallback cannot leak into other payment methods or unavailable imports', () => {
  for (const payment_method of ['card', 'admin_import', undefined]) {
    assert.equal(registrationTicketPriceExport({ ...legacy, payment_method }), 'Unavailable');
  }
  assert.equal(registrationTicketPriceExport({ ...legacy, ticket_price_status: 'unavailable_import_financials' }), 'Unavailable');
  assert.equal(registrationTicketPriceExport({ ticket_price: 204.5 }), '204.50');
  assert.equal(registrationTicketPriceExport({}), 'Unavailable');
});

test('known code discount including zero is partial, never an invented full discount', () => {
  assert.deepEqual(registrationDiscountPresentation(payment), { amount: 0, recorded: true, partial: true });
  assert.match(registrationDiscountExport(payment), /^0.00.*recorded code discount only; offer discount unknown/);
  assert.match(registrationDiscountExport({ ...payment, codeDiscount: 8.25 }), /^-8.25.*unknown/);
  for (const codeDiscount of [null, undefined, '', 'invalid', Infinity]) {
    assert.equal(registrationDiscountExport({ ...payment, codeDiscount }), 'Unavailable');
  }
  assert.equal(registrationDiscountExport({ ...payment, totalsStatus: 'unavailable_import_financials' }), 'Unavailable');
  assert.deepEqual(registrationDiscountPresentation({ discount: 12.75, codeDiscount: 4 }), { amount: 12.75, recorded: false, partial: false });
  assert.equal(registrationDiscountExport({ discount: 0 }), '0.00');
});

test('actual report summary sums displayed ticket amounts and counts group discounts once', () => {
  const source = readFileSync(new URL('../pages/EventRegistrationReport.jsx', import.meta.url), 'utf8');
  const start = source.indexOf('    let totalVoucher = 0;', source.indexOf('  const filteredSummary ='));
  const end = source.indexOf('\n  },', start);
  const calculate = new Function(
    'filteredGroups', 'totalAttendees', 'summarizeRegistrationCredits', 'summarizeRegistrationRevenue',
    'financialAmount', 'isGrossSnapshotUnavailable', 'registrationDiscountPresentation', 'registrationTicketPricePresentation',
    source.slice(start, end),
  );
  const summarize = payments => calculate(
    payments.map(groupPayment => ({ groupPayment, attendees: [legacy, { ticket_price: 100 }] })), 0, () => ({}), () => ({}),
    financialAmount, isGrossSnapshotUnavailable, registrationDiscountPresentation, registrationTicketPricePresentation,
  );
  const mixed = summarize([{ discount: 12.75, codeDiscount: 4 }, { ...payment, codeDiscount: 3.5 }, payment]);
  assert.equal(mixed.totalDiscount, 16.25);
  assert.equal(mixed.hasUnavailableDiscountTotal, true);
  assert.equal(mixed.totalTicketPrice.toFixed(2), '800.01');
  assert.equal(mixed.totalFooterDiscount, 16.25);
  assert.equal(mixed.hasUnavailableTicketTotal, false);
  assert.equal(mixed.hasUnavailableDiscount, false);
  assert.equal(summarize([payment]).totalDiscount, 0);
  assert.equal(summarize([{}]).totalDiscount, 0);
  assert.equal(summarize([{}]).hasUnavailableDiscountTotal, true);
  assert.equal(summarize([{}]).hasRecordedDiscount, false);
  assert.equal(summarize([{ discount: 0 }]).hasRecordedDiscount, true);
  assert.equal(summarize([{ discount: 0 }]).hasUnavailableDiscountTotal, false);
  assert.equal(summarize([]).totalDiscount, 0);
  assert.match(source, /Recorded \/ partial/);
});

test('pending Price Paid UI has amount only and explicit unpaid state, missing remains unavailable', () => {
  assert.deepEqual(registrationPricePaidPresentation({ price_paid_status: 'pending', price_paid: 166.67 }), { label: '£166.67', pending: true });
  assert.deepEqual(registrationPricePaidPresentation({ price_paid_status: 'pending', price_paid: null }), { label: 'Unavailable', pending: true });
  assert.deepEqual(registrationPricePaidPresentation({ price_paid_status: 'net', price_paid: 0 }), { label: '£0.00', pending: false });
  assert.deepEqual(registrationPricePaidPresentation({}), { label: 'Unavailable', pending: false });
});
