import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { allocateBillingMinor, buildBillingSchedule, billingCalendarDate, resolveBillingTimezone } from './salesBilling.js';
import { percentageInstalmentErrors, resolvePercentageInstalments } from './salesBillingConfiguration.js';

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

const instalments = [2500, 7500].map((percentageBps, i) => ({
  id: randomUUID(), name: i ? 'Balance' : 'Deposit', percentageBps,
  issueDelayPreset: { id: randomUUID(), name: i ? 'Later' : 'On acceptance', days: i * 30 },
  paymentTerms: terms,
}));
const percentage = (lines, items = instalments) => buildBillingSchedule({ lines, currency: 'GBP',
  billingMode: 'percentage', percentageInstalments: items, timezone: 'UTC', timezoneFallback: false,
  recipient: { email: null }, newId: randomUUID });
test('percentage schedule splits every discounted line and mixed VAT, ignoring bundle grouping', () => {
  const zero = { ...line, kind: 'free_text', netMinor: 100, taxMinor: 0, grossMinor: 100, taxRateBps: 0 };
  const vat = { ...line, netMinor: 200, taxMinor: 40, grossMinor: 240, discountBps: 5000 };
  const result = percentage([zero, vat, { ...vat, kind: 'product' }]);
  assert.equal(result.mode, 'percentage');
  assert.deepEqual(result.percentageInstalments, instalments);
  assert.deepEqual(result.groups.map(g => [g.netMinor, g.taxMinor, g.grossMinor]), [[125, 20, 145], [375, 60, 435]]);
  assert.deepEqual(result.groups.map(g => g.timing.days), [0, 30]);
  assert.deepEqual(result.groups.map(g => g.paymentTerms.days), [14, 14]);
  assert.deepEqual(result.groups.map(g => g.id), instalments.map(i => i.id));
  assert.equal(result.groups[0].invoiceLines.length, 3);
  assert.deepEqual(result.groups[0].invoiceLines[1].taxCode, vat.catalogueSnapshot.tax_code);
});
test('percentage pennies target whole proposal gross, not independent source-line rounding', () => {
  const penny = { ...line, kind: 'free_text', netMinor: 1, taxMinor: 0, grossMinor: 1, taxRateBps: 0 };
  const halves = instalments.map(i => ({ ...i, percentageBps: 5000 }));
  const result = percentage([penny, penny], halves);
  assert.deepEqual(result.groups.map(g => g.grossMinor), [1, 1]);
  assert.deepEqual(percentage([penny, penny, penny], halves).groups.map(g => g.grossMinor), [2, 1]);
  assert.deepEqual(percentage([{ ...penny, netMinor: 0, grossMinor: 0 }]).groups.map(g => g.grossMinor), [0, 0]);
  assert.throws(() => percentage([{ ...line, netMinor: 5, taxMinor: 1, grossMinor: 6 }], halves), /rounding/);
  assert.throws(() => percentage([{ ...line, taxRateBps: null }]), /authoritative/);
});
test('percentage config rejects invalid totals, forged amounts, duplicate IDs and missing timing', () => {
  assert.deepEqual(percentageInstalmentErrors(instalments), []);
  for (const invalid of [[], [{ ...instalments[0], percentageBps: 9999 }],
    instalments.map(i => ({ ...i, id: instalments[0].id })),
    instalments.map(i => ({ ...i, issueDelayPreset: null })),
    instalments.map(i => ({ ...i, grossMinor: 100 })),
    instalments.map(i => ({ ...i, percentageBps: 5000.5 }))]) {
    assert.ok(percentageInstalmentErrors(invalid).length);
  }
});
test('percentage preset resolver trusts tenant presets, or unchanged previous snapshots only', () => {
  const presets = { issueDelays: instalments.map(i => ({ ...i.issueDelayPreset, days: 42, isActive: true })),
    paymentTerms: [{ ...terms, days: 21, isActive: true }] };
  const current = resolvePercentageInstalments(instalments, presets);
  assert.equal(current[0].issueDelayPreset.days, 42);
  assert.equal(current[0].paymentTerms.days, 21);
  assert.deepEqual(resolvePercentageInstalments(instalments, {}, instalments), instalments);
  assert.throws(() => resolvePercentageInstalments(instalments, {}), /belonging to this tenant/);
  assert.throws(() => resolvePercentageInstalments(instalments.map(i => ({ ...i,
    paymentTerms: { ...terms, days: 999 } })), {}, instalments), /belonging to this tenant/);
});
