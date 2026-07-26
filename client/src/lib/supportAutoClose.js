// Tenant-configurable auto-close of resolved support tickets.
// Mirrors the server-side parsing in api/_lib/supportCsat.js.

export const SUPPORT_AUTO_CLOSE_KEY = 'support_auto_close';

export const AUTO_CLOSE_DEFAULTS = Object.freeze({
  enabled: false,
  warnDays: 7,
  closeDays: 10,
});

/**
 * Resolve the auto-close settings from the tenant SystemSettings rows.
 * Invalid or missing config falls back to the defaults (disabled).
 */
export function resolveAutoCloseSettings(settings) {
  const row = (settings || []).find((s) => s.setting_key === SUPPORT_AUTO_CLOSE_KEY);
  if (!row || !row.setting_value) return { ...AUTO_CLOSE_DEFAULTS };
  try {
    const parsed = JSON.parse(row.setting_value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ...AUTO_CLOSE_DEFAULTS };
    const warnDays = Number.isInteger(parsed.warnDays) && parsed.warnDays >= 1 ? parsed.warnDays : AUTO_CLOSE_DEFAULTS.warnDays;
    let closeDays = Number.isInteger(parsed.closeDays) && parsed.closeDays >= 1 ? parsed.closeDays : AUTO_CLOSE_DEFAULTS.closeDays;
    if (closeDays <= warnDays) closeDays = warnDays + 1;
    return { enabled: parsed.enabled === true, warnDays, closeDays };
  } catch {
    return { ...AUTO_CLOSE_DEFAULTS };
  }
}
