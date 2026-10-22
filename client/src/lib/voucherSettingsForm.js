export const VOUCHER_SETTING_KEYS = ['individual_vouchers_enabled', 'organization_voucher_display_name', 'member_voucher_display_name'];

export function voucherSettingsForm(rows) {
  return Object.fromEntries(VOUCHER_SETTING_KEYS.map(key => {
    const row = rows.find(item => item.setting_key === key);
    return [key, { id: row?.id, value: row?.setting_value || '' }];
  }));
}

export function voucherSettingsPayload(key, row) {
  if (!VOUCHER_SETTING_KEYS.includes(key)) throw new Error('Unknown voucher setting');
  return { setting_key: key, setting_value: key === 'individual_vouchers_enabled' ? String(row.value === 'true') : row.value.trim(), setting_type: 'string' };
}
