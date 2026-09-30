// Shared resolver for tenant-customizable seat-availability labels shown on
// event cards / lists / detail pages (Task: customizable seat-status labels).
//
// Three SystemSettings keys, saved from Event Settings:
//   - seat_label_unlimited  (default "Open Registration")
//   - seat_label_available  (template with {count}, default "{count} seats available")
//   - seat_label_sold_out   (default "Sold out")
//
// Blank/unset values fall back to the defaults so existing tenants keep the
// current wording. This helper only renames labels — it never changes which
// status applies.

export const SEAT_LABEL_UNLIMITED_KEY = 'seat_label_unlimited';
export const SEAT_LABEL_AVAILABLE_KEY = 'seat_label_available';
export const SEAT_LABEL_SOLD_OUT_KEY = 'seat_label_sold_out';

export const SEAT_LABEL_DEFAULTS = {
  unlimited: 'Open Registration',
  available: '{count} seats available',
  soldOut: 'Sold out',
};

const findSettingValue = (systemSettings, key) => {
  if (!Array.isArray(systemSettings)) return '';
  const setting = systemSettings.find(s => s?.setting_key === key);
  return typeof setting?.setting_value === 'string' ? setting.setting_value.trim() : '';
};

/**
 * Resolve the three seat-status labels from loaded system settings.
 *
 * @param {Array} systemSettings - rows from SystemSettings / public settings list
 * @param {Object} [opts]
 * @param {string} [opts.availableDefault] - fallback template for the
 *   seats-available label when the tenant hasn't customized it (some surfaces
 *   historically say "places" instead of "seats").
 * @returns {{
 *   unlimited: string,
 *   isUnlimitedCustom: boolean,
 *   soldOut: string,
 *   available: (count: number|string) => string,
 * }}
 */
export function getSeatStatusLabels(systemSettings, { availableDefault } = {}) {
  const customUnlimited = findSettingValue(systemSettings, SEAT_LABEL_UNLIMITED_KEY);
  const customAvailable = findSettingValue(systemSettings, SEAT_LABEL_AVAILABLE_KEY);
  const customSoldOut = findSettingValue(systemSettings, SEAT_LABEL_SOLD_OUT_KEY);

  const availableTemplate = customAvailable || availableDefault || SEAT_LABEL_DEFAULTS.available;

  return {
    unlimited: customUnlimited || SEAT_LABEL_DEFAULTS.unlimited,
    isUnlimitedCustom: !!customUnlimited,
    soldOut: customSoldOut || SEAT_LABEL_DEFAULTS.soldOut,
    available: (count) => {
      const countStr = String(count);
      if (availableTemplate.includes('{count}')) {
        return availableTemplate.replaceAll('{count}', countStr);
      }
      // Custom label without a {count} placeholder: prepend the number so the
      // count is never silently lost.
      return `${countStr} ${availableTemplate}`.trim();
    },
  };
}
