import test from 'node:test';
import assert from 'node:assert/strict';
import { voucherSettingsForm, voucherSettingsPayload } from './voucherSettingsForm.js';
import { normalizeVoucherSettings } from '../../../shared/voucherPolicy.js';

test('form saves independent trimmed names; clearing one never copies the other', () => {
  const form = voucherSettingsForm([
    { id: 'org-row', setting_key: 'organization_voucher_display_name', setting_value: ' Credit ' },
    { id: 'member-row', setting_key: 'member_voucher_display_name', setting_value: ' Learning balance ' },
  ]);
  form.member_voucher_display_name.value = ' ';
  const saved = Object.fromEntries(Object.entries(form).map(([key, row]) => [key, voucherSettingsPayload(key, row).setting_value]));
  assert.deepEqual(normalizeVoucherSettings(saved), {
    individual_vouchers_enabled: false,
    organization_voucher_display_name: 'Credit',
    member_voucher_display_name: 'Training Voucher',
  });
  assert.equal(form.organization_voucher_display_name.id, 'org-row');
  assert.equal(form.member_voucher_display_name.id, 'member-row');
  assert.equal(voucherSettingsForm([]).organization_voucher_display_name.value, '');
});
