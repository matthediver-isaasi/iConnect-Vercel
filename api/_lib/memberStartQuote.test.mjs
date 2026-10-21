import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStartQuote, normalizeStart, startFingerprint } from './memberStartQuote.js';

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const request = { memberId: id(1), configId: id(2), bandId: null, startDate: '2026-03-01', reason: 'Explicit new purchase', paymentMode: 'invoice' };
const config = { id: id(2), tenant_id: id(3), structure_scope_type: 'member', is_active: true, billing_period: 'annual',
  start_mode: 'immediate', effective_from: '2025-01-01', currency: 'GBP', pricing_model: 'flat', flat_cost: 120 };
const quote = changes => buildStartQuote({ request, config, today: '2026-03-01', ...changes });
test('rolling upfront quote persists exact explicit structure and dates, never custom expiry/class', () => {
  const q = quote();
  assert.equal(q.termStart, '2026-03-01');
  assert.equal(q.termEnd, '2027-02-28');
  assert.equal(q.totalWithVat, 120);
  assert.equal(q.commitment.commitment_snapshot.payment_frequency, 'upfront');
  assert.deepEqual(q.commitment.commitment_snapshot.config, config);
});
test('fixed-date start prorates exactly as existing four-decimal member-fee arithmetic', () => {
  const q = quote({ config: { ...config, start_mode: 'fixed_date', prorata_enabled: true, membership_start_month: 1, membership_start_day: 1 } });
  assert.equal(q.termEnd, '2026-12-31');
  assert.equal(q.membershipYear, '2026/2027');
  assert.equal(q.prorataDays, 306);
  assert.equal(q.finalCost, 100.61);
});
test('selected band and saved VAT are authoritative; invalid selection/tax never becomes free', () => {
  const band = { id: id(4), config_id: id(2), tenant_id: id(3), label: 'Selected', annual_cost: 100, vat_rate: 'OUTPUT2' };
  const q = quote({ request: { ...request, bandId: id(4) }, config: { ...config, pricing_model: 'tiered' }, band,
    vatSetting: { setting_value: '{"rates":[{"taxType":"OUTPUT2","effectiveRate":20}]}' } });
  assert.equal(q.totalWithVat, 120);
  assert.equal(q.bandId, band.id);
  assert.throws(() => quote({ config: { ...config, flat_cost: null } }), /configured price/);
  assert.throws(() => quote({ config: { ...config, flat_vat_rate: 'UNKNOWN' } }), /authoritative/);
  assert.throws(() => quote({ request: { ...request, bandId: id(4) } }), /Select one band/);
});
test('legitimate free purchase only; complex pricing, backdating and unsupported modes fail closed', () => {
  const free = quote({ request: { ...request, paymentMode: 'free' }, config: { ...config, flat_cost: 0 } });
  assert.equal(free.totalWithVat, 0);
  assert.equal(free.commitment.commitment_snapshot.payment_method, 'free');
  assert.throws(() => quote({ request: { ...request, paymentMode: 'free' } }), /choose invoice/);
  assert.throws(() => quote({ config: { ...config, flat_cost: 0 } }), /choose free/);
  for (const change of [{ discounts: [{}] }, { overrides: [{}] }, { vatOverrides: [{}] }, { config: { ...config, rollover_enabled: true } }]) {
    assert.throws(() => quote(change), /does not approximate/);
  }
  assert.throws(() => quote({ today: '2026-03-02' }), /Backdating/);
  assert.throws(() => normalizeStart({ ...request, paymentMode: 'direct_debit' }), /Only invoice or free/);
  assert.throws(() => normalizeStart({ ...request, startDate: '2026-02-30' }), /valid effectiveDate/);
});
test('confirmation fingerprint includes structure snapshots, reason, dates and payment mode', () => {
  const a = startFingerprint({ request, quote: quote() });
  assert.equal(a, startFingerprint({ quote: quote(), request }));
  assert.notEqual(a, startFingerprint({ request: { ...request, reason: 'Different' }, quote: quote() }));
  assert.throws(() => normalizeStart(request, true), /stable idempotencyKey/);
});
