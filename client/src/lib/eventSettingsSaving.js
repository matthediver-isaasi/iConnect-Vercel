// Page-local write authority. Never infer success from a fulfilled HTTP request
// with an error envelope, or choose arbitrarily between duplicate settings.
export function createEventSettingsWriter({ entity, getRows, acknowledge }) {
  const write = async (key, data) => {
    const matches = getRows().filter(row => row.setting_key === key);
    if (matches.length > 1) throw new Error(`Duplicate setting "${key}". No changes made to this setting.`);
    const existing = matches[0];
    if (existing && existing.setting_value === data.setting_value) return existing;
    const result = existing
      ? await entity.update(existing.id, data)
      : await entity.create({ ...data, setting_key: key });
    if (!result?.id || result.error || result.setting_value !== data.setting_value) {
      throw new Error(`Could not confirm saved value for "${key}". Your draft has been retained.`);
    }
    acknowledge({ ...existing, ...result, setting_key: key });
    return result;
  };
  return {
    ...entity,
    list: (...args) => entity.list(...args),
    create: ({ setting_key, ...data }) => write(setting_key, data),
    update: (id, data) => {
      const row = getRows().find(item => item.id === id);
      if (!row) throw new Error('Setting no longer exists. Reload before saving.');
      return write(row.setting_key, data);
    },
  };
}

// The legacy serializer builds all values, but only the clicked section writes.
// Collect synchronously before the first network request to snapshot the draft.
export function createSettingsCollector(rows) {
  const entries = new Map();
  return {
    entries,
    create: ({ setting_key, ...data }) => { entries.set(setting_key, data); },
    update: (id, data) => {
      const row = rows.find(item => item.id === id);
      if (!row) throw new Error('Unknown setting');
      entries.set(row.setting_key, data);
    },
  };
}

export async function saveCollectedSettings(entries, keys, writer) {
  if (!keys?.length) throw new Error('No settings selected for saving');
  for (const key of keys) {
    const data = entries.get(key);
    if (data) await writer.create({ setting_key: key, ...data });
  }
}

export const EVENT_SETTINGS_SAVE_KEYS = {
  'button-save-transfer-settings': ['transfer_restrict_by_role'],
  'button-save-donation-settings': ['event_donation_enabled'],
  'button-save-event-payment-methods': ['event_allow_voucher_payment', 'event_allow_training_fund_payment'],
  'button-save-voucher-settings': ['allow_voucher_use_after_expiry'],
  'button-save-attendee-options-settings': ['collect_attendee_options'],
  'button-save-po-notification-email': ['po_submission_notification_email'],
  'button-save-summary-settings': ['event_summary_max_length'],
  'button-save-field-requirements': ['require_internal_reference', 'require_attendee_job_title'],
  'button-save-description-preview-settings': ['event_description_preview_lines'],
  'button-save-display-settings': ['show_event_seats'],
  'button-save-seat-labels': ['seat_label_unlimited', 'seat_label_available', 'seat_label_sold_out'],
  'button-save-time-format-settings': ['event_time_format_24h', 'event_display_timezones'],
  'button-save-title-clamp-settings': ['event_card_title_clamp'],
  'button-save-prices-settings': ['show_event_card_prices'],
  'button-save-sponsors-placement': ['event_sponsors_placement'],
  'button-save-featured-bg': ['featured_events_background'],
  'button-save-tbc-banner': ['tbc_events_banner'],
};
