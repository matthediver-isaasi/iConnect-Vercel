import test from 'node:test';
import assert from 'node:assert/strict';
import { billingPresetErrors, bundleBillingGroupErrors, resolveBillingGroups } from './salesBillingConfiguration.js';
import { validateSalesSettingsPatch, validateCatalogueBundle, mapSalesSettingsRow } from './salesContracts.js';
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const preset = { id: id(1), name: 'Pay in seven days', days: 7, isActive: true, isDefault: true };
const terms = { id: preset.id, name: preset.name, days: preset.days };
const presets = { issueDelays: [], paymentTerms: [preset] };
const group = { id: id(2), name: 'Deposit', position: 0, allocatedMinor: 101, productIds: [id(3)],
  timing: { kind: 'acceptance', days: 0 }, paymentTerms: terms };
test('settings distinguish invoice delay and time to pay, with strict defaults and identities', () => {
  assert.deepEqual(billingPresetErrors(presets), []);
  assert.equal(validateSalesSettingsPatch({ billingPresets: presets, expectedVersion: 1 }).ok, true);
  for (const value of [null, {}, { ...presets, paymentTerms: [{ ...preset, days: '7' }] },
    { ...presets, paymentTerms: [{ ...preset, days: -1 }] }, { ...presets, paymentTerms: [{ ...preset, days: 0.5 }] },
    { ...presets, paymentTerms: [{ ...preset, isActive: false }] }, { ...presets, paymentTerms: [preset, preset] }]) {
    assert.ok(billingPresetErrors(value).length);
  }
  assert.deepEqual(mapSalesSettingsRow({ billing_presets: presets }).billingPresets, presets);
});
test('group allocations and membership reproduce independent bundle price exactly', () => {
  const items = [{ productId: id(3), quantity: 2 }];
  assert.deepEqual(bundleBillingGroupErrors([group], items, 101), []);
  assert.ok(bundleBillingGroupErrors([group], items, 100).length);
  assert.ok(bundleBillingGroupErrors([group, { ...group, id: id(4), position: 1, allocatedMinor: 0 }], items, 101).length);
  assert.ok(bundleBillingGroupErrors([group], [{ productId: id(5), quantity: 1 }], 101).length);
  assert.ok(bundleBillingGroupErrors([{ ...group, timing: { kind: 'fixed', date: '2026-02-30' } }], items, 101).length);
  assert.equal(validateCatalogueBundle({ billingGroups: [group], items, sellingPriceMinor: 101 }, { patch: true }).ok, true);
});
test('preset authority is tenant-owned and deactivation preserves only unchanged saved snapshots', () => {
  assert.deepEqual(resolveBillingGroups([group], presets), [group]);
  assert.throws(() => resolveBillingGroups([group], { paymentTerms: [] }), /active payment-term/);
  assert.deepEqual(resolveBillingGroups([group], { paymentTerms: [] }, [group]), [group]);
  assert.throws(() => resolveBillingGroups([{ ...group, paymentTerms: { ...terms, days: 0 } }], { paymentTerms: [] }, [group]), /active payment-term/);
  assert.equal(resolveBillingGroups([{ ...group, paymentTerms: { ...terms, days: 99 } }], presets)[0].paymentTerms.days, 7);
  assert.equal(resolveBillingGroups([group], { paymentTerms: [{ ...preset, days: 14 }] }, [group])[0].paymentTerms.days, 7);
});
