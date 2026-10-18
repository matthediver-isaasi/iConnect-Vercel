import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { allocateBillingMinor, buildBillingSchedule, billingCalendarDate, resolveBillingTimezone } from './salesBilling.js';

test('largest remainders are exact and deterministic including safe integer boundary', () => {
  assert.deepEqual(allocateBillingMinor(10, [1, 1, 1]), [4, 3, 3]);
  assert.deepEqual(allocateBillingMinor(2, [0, 0, 0]), [1, 1, 0]);
  const total = Number.MAX_SAFE_INTEGER;
  assert.equal(allocateBillingMinor(total, [total, total]).reduce((a,b)=>a+b), total);
  assert.throws(() => allocateBillingMinor(-1, [1]));
});
test('calendar days respect local midnight, DST, leap years and explicit fallback', () => {
  assert.equal(billingCalendarDate('2024-03-10T04:30:00Z', 'America/New_York', 1), '2024-03-10');
  assert.equal(billingCalendarDate('2024-02-28T23:30:00Z', 'UTC', 2), '2024-03-01');
  assert.deepEqual(resolveBillingTimezone(null), { timezone: 'UTC', timezoneFallback: true });
  assert.throws(() => resolveBillingTimezone('invalid/timezone'));
});
const terms = { id: randomUUID(), name: '14 days', days: 14 };
const product = randomUUID();
const group = { id: randomUUID(), name: 'Deposit', position: 0, productIds: [product],
  allocatedMinor: 100, timing: { kind: 'acceptance', days: 7 }, paymentTerms: terms };
const line = { kind: 'bundle', standardUnitPriceMinor: 100, netMinor: 270, taxMinor: 54, grossMinor: 324,
  quantity: '3', taxRateBps: 2000, catalogueSnapshot: { billing_groups: [group], tax_code: { id: 'VAT', provider: 'xero' } },
  components: [{ productId: product, productSnapshot: { name: 'Room' }, quantity: 1 }] };
const build = lines => buildBillingSchedule({ lines, currency: 'GBP', recipient: { email: null },
  timezone: 'UTC', timezoneFallback: true, remainderPaymentTerms: terms, newId: randomUUID });
test('repeated bundle instances have independent IDs and exact authoritative amounts; mixed remainder is explicit', () => {
  const result = build([line, line, { ...line, kind: 'free_text', description: 'Extra' }]);
  assert.equal(new Set(result.groups.map(g=>g.id)).size, 3);
  assert.equal(result.groups.reduce((n,g)=>n+g.grossMinor,0), 972);
  assert.equal(result.groups[2].name, 'Remainder');
  assert.equal(result.groups[2].invoiceLines[0].taxRateBps, 2000);
  assert.deepEqual(result.groups[0].paymentTerms, terms);
  assert.equal(result.groups[0].timing.days, 7);
  assert.equal(result.groups[0].contents[0].quantity, '3');
  assert.notEqual(result.groups[0].bundleLineLabel, result.groups[1].bundleLineLabel);
  assert.deepEqual(build([line]).remainderPaymentTerms, terms);
});
test('reject missing membership, invalid allocations and provider-unrepresentable rounding', () => {
  assert.throws(()=>build([{ ...line, standardUnitPriceMinor: 101 }]), /selling price/);
  assert.throws(()=>build([{ ...line, components: [] }]), /exactly one/);
  assert.throws(()=>build([{ ...line, taxMinor: 53 }]), /rounding/);
});
test('zero gross remains a visible scheduled group', () => {
  const result = build([{ ...line, netMinor: 0, taxMinor: 0, grossMinor: 0 }]);
  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].grossMinor, 0);
});
