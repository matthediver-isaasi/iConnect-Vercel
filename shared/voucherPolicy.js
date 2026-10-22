/** Stable storage keys; values from system_settings may be strings or parsed. */
export function normalizeVoucherSettings(settings = {}) {
  const values = Array.isArray(settings)
    ? Object.fromEntries(settings.map(row => [row.setting_key, row.setting_value]))
    : (settings || {});
  const name = value => typeof value === 'string' && value.trim() ? value.trim() : 'Training Voucher';
  return {
    individual_vouchers_enabled: values.individual_vouchers_enabled === true || values.individual_vouchers_enabled === 'true',
    organization_voucher_display_name: name(values.organization_voucher_display_name),
    member_voucher_display_name: name(values.member_voucher_display_name),
  };
}

/** Invalid dual/no-owner records fail closed rather than falling back to org. */
export function voucherOwnerType(voucher) {
  if (!!voucher?.member_id === !!voucher?.organization_id) return null;
  return voucher.member_id ? 'member' : 'organization';
}

export function voucherDisplayName(settings, ownerType) {
  const normalized = normalizeVoucherSettings(settings);
  return ownerType === 'member' ? normalized.member_voucher_display_name : normalized.organization_voucher_display_name;
}
