import test from 'node:test';
import assert from 'node:assert/strict';
import { projectUpfrontRenewalAmount as project } from './membershipPaymentReportAmount.js';
import { membershipPaymentReportCsv } from './membershipPaymentReportCsv.js';

const config = { id: 'c', tenant_id: 't', currency: 'GBP', pricing_model: 'flat', flat_cost: '125',
  membership_start_month: 1, membership_start_day: 1 };
const input = { tenantId: 't', row: { nextStructureId: 'c', renewalDate: '2027-01-01' },
  member: { id: 'm' }, configs: [config], preferences: [] };
const run = (c = {}, rest = {}) => project({ ...input, configs: [{ ...config, ...c }], ...rest });
const override = rest => ({ tenant_id: 't', member_id: 'm', ...rest });

test('current next structure price, real zero and missing price stay distinct', () => {
  assert.equal(run().nextRenewalAmount, 125);
  assert.equal(run({ flat_cost: 0 }).nextRenewalAmount, 0);
  for (const flat_cost of [null, undefined, '', -1, 'junk']) assert.equal(run({ flat_cost }).nextRenewalAmount, null);
  assert.equal(run({ currency: null }).nextRenewalAmount, null);
  assert.equal(run({ tenant_id: 'foreign' }).nextRenewalAmount, null);
  assert.equal(run({ billing_period: 'monthly' }).nextRenewalAmount, null);
});
test('VAT gross uses cached effective rate or evidenced percent; unknown is review', () => {
  assert.equal(run({ flat_vat_rate: '20% VAT' }).nextRenewalAmount, 150);
  assert.equal(run({ flat_vat_rate: 'Unresolved' }).nextRenewalAmount, null);
  const settings = [{ tenant_id: 't', setting_key: 'xero_vat_rates_t',
    setting_value: JSON.stringify({ rates: [{ taxType: 'OUTPUT', effectiveRate: 20 }] }) }];
  assert.equal(run({ flat_vat_rate: '{"taxType":"OUTPUT"}' }, { settings }).nextRenewalAmount, 150);
  assert.equal(run({ flat_vat_rate: '{"taxType":"OUTPUT"}' }, {
    settings: [{ ...settings[0], tenant_id: 'foreign' }],
  }).nextRenewalAmount, null);
});
test('year specific overrides take precedence, discounts applied once before VAT', () => {
  const overrides = [override({ override_type: 'price', manual_price: 90 }),
    override({ membership_year: '2027/2028', override_type: 'discount', discount_type: 'percentage', discount_value: 10 }),
    override({ membership_year: '2026/2027', override_type: 'price', manual_price: 1 })];
  assert.equal(run({ flat_vat_rate: '20% VAT' }, { overrides }).nextRenewalAmount, 135);
  assert.equal(run({}, { overrides: [override({ override_type: 'price', manual_price: 0 })] }).nextRenewalAmount, 0);
  assert.equal(run({}, { overrides: [override({ override_type: 'discount', discount_type: 'fixed', discount_value: 25 })] }).nextRenewalAmount, 100);
  assert.equal(run({}, { overrides: [override({ override_type: 'price', manual_price: 90, tenant_id: 'foreign' })] }).nextRenewalAmount, 125);
  assert.equal(run({}, { overrides: [overrides[0], overrides[0]] }).nextRenewalAmount, null);
});
test('band matching requires actual scoped input and unique band, never first/default band', () => {
  const bands = [{ id: 'b', tenant_id: 't', config_id: 'c', match_value: 'Full', annual_cost: 50 }];
  const c = { pricing_model: 'banded', field_id: 'field' };
  assert.equal(run(c, { bands }).nextRenewalAmount, null);
  const preferences = [{ tenant_id: 't', member_id: 'm', field_id: 'field', value: 'full' }];
  assert.equal(run(c, { bands, preferences }).nextRenewalAmount, 50);
  assert.equal(run(c, { bands: [...bands, ...bands], preferences }).nextRenewalAmount, null);
  assert.equal(run(c, { bands, preferences: [{ ...preferences[0], tenant_id: 'foreign' }] }).nextRenewalAmount, null);
  assert.equal(run({ pricing_model: 'banded', field_source: 'core', field_name: 'count' },
    { member: { id: 'm', count: 10 }, bands: [{ ...bands[0], match_value: null, min_value: 1, max_value: 10 }] }).nextRenewalAmount, 50);
});
test('conditional VAT and unresolved incentive/structure evidence remain explicit', () => {
  const vatRules = [{ tenant_id: 't', config_id: 'c', field_id: 'v', match_value: 'yes', vat_rate: '0%' }];
  assert.equal(run({ flat_vat_rate: '20%' }, { vatRules }).nextRenewalAmount, null);
  assert.equal(run({ flat_vat_rate: '20%' }, { vatRules,
    preferences: [{ tenant_id: 't', member_id: 'm', field_id: 'v', value: 'yes' }] }).nextRenewalAmount, 125);
  assert.equal(run({ free_period_amount: 2 }).nextRenewalAmount, null);
  assert.equal(run({ rollover_enabled: true }).nextRenewalAmount, null);
  assert.equal(run({}, { overrides: [override({ override_type: 'structure', config_id: 'other' })] }).nextRenewalAmount, null);
});
test('CSV distinguishes zero, missing evidence and currency without changing other payment exports', () => {
  const row = { paymentMethod: 'upfront', ...run({ flat_cost: 0, currency: 'EUR' }) };
  assert.match(membershipPaymentReportCsv([row], 'upfront'), /,0.00,EUR\r\n$/);
  assert.match(membershipPaymentReportCsv([{ ...row, ...run({ flat_cost: null }) }], 'upfront'), /Review required — price missing/);
  assert.doesNotMatch(membershipPaymentReportCsv([row], 'card'), /Next renewal amount/);
});