// Tenant-wide toggle for collecting dietary / allergy / accessibility needs
// at booking (Event Settings -> "Collect dietary & accessibility needs").
// Defaults to enabled so existing tenants see no change.
export const ATTENDEE_OPTIONS_SETTING_KEY = 'collect_attendee_options';

export function isAttendeeOptionsCollectionEnabled(settings) {
  const setting = Array.isArray(settings)
    ? settings.find((s) => s.setting_key === ATTENDEE_OPTIONS_SETTING_KEY)
    : null;
  return !setting || setting.setting_value !== 'false';
}
