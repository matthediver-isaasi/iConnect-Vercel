// Tenant policy: may a voucher be used to pay for an event that takes place
// AFTER the voucher's expiry date?
//
// Setting key: allow_voucher_use_after_expiry (default 'true' = legacy behaviour).
// When the tenant turns it off, a voucher is only usable for a booking if the
// voucher expires after the event's start date.

/**
 * Reads the tenant's allow_voucher_use_after_expiry setting.
 * Defaults to true (allowed) when the setting row is missing or unreadable.
 * @param {object} supabase - supabase client
 * @param {string} tenantId
 * @returns {Promise<boolean>} true if vouchers may outlive the event date rule
 */
export async function getAllowVoucherUseAfterExpiry(supabase, tenantId) {
  if (!tenantId) return true;
  try {
    const { data } = await supabase
      .from('system_settings')
      .select('setting_value')
      .eq('tenant_id', tenantId)
      .eq('setting_key', 'allow_voucher_use_after_expiry')
      .maybeSingle();
    return data?.setting_value !== 'false';
  } catch (err) {
    console.error('[voucherExpiryPolicy] Failed to read setting, defaulting to allowed:', err?.message);
    return true;
  }
}

/**
 * Returns true if the voucher may be used for an event starting at eventStartDate
 * under the given policy. Vouchers without an expiry are always usable.
 * @param {object} voucher - row with expires_at
 * @param {string|Date|null} eventStartDate
 * @param {boolean} allowAfterExpiry - tenant policy flag
 */
export function isVoucherUsableForEventDate(voucher, eventStartDate, allowAfterExpiry) {
  if (allowAfterExpiry) return true;
  if (!voucher?.expires_at || !eventStartDate) return true;
  const expiry = new Date(voucher.expires_at);
  const eventStart = new Date(eventStartDate);
  if (isNaN(expiry.getTime()) || isNaN(eventStart.getTime())) return true;
  return expiry > eventStart;
}
