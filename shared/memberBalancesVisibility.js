// This is presentation only; financial and reporting authority is unchanged.
export function memberBalancesVisible(settings) {
  return settings != null && (
    !Object.prototype.hasOwnProperty.call(settings, 'show_member_balances_tab')
    || settings.show_member_balances_tab === true
  );
}
