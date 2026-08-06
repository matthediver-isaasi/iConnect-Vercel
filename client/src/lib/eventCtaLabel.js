// Shared event-card CTA label resolution.
//
// Resolution order (Task: per-event CTA button label override):
//   status label ("Registration Closed" / "Sold Out")
//     > per-event override (event.cta_button_label)
//     > tenant-wide default (Event Settings `event_cta_button` system setting)
//     > surface fallback (admin card: "Register", public lists: "View Details")

export const REGISTRATION_CLOSED_LABEL = 'Registration Closed';
export const SOLD_OUT_LABEL = 'Sold Out';

/**
 * Whether registration for an event is closed: event_state 'closed'
 * (or legacy status 'closed' when event_state is null), or the
 * registration_closes_at deadline has passed.
 */
export const isEventRegistrationClosed = (event, now = new Date()) => {
  if (!event) return false;
  return (
    event.event_state === 'closed' ||
    (!event.event_state && event.status === 'closed') ||
    (event.registration_closes_at ? now > new Date(event.registration_closes_at) : false)
  );
};

/**
 * Tenant-wide default CTA label from the `event_cta_button` system setting.
 * Falls back to the given surface fallback when unset/unparseable.
 */
export const getTenantCtaLabel = (systemSettings, fallback = 'View Details') => {
  const setting = Array.isArray(systemSettings)
    ? systemSettings.find((s) => s.setting_key === 'event_cta_button')
    : null;
  if (setting?.setting_value) {
    try {
      const config = JSON.parse(setting.setting_value);
      if (config.label) return config.label;
    } catch {
      /* fall through to fallback */
    }
  }
  return fallback;
};

/**
 * Resolve the label to show on an event card CTA button.
 * Status labels always win over any per-event override.
 */
export const resolveEventCtaLabel = ({
  isRegistrationClosed = false,
  isSoldOut = false,
  perEventLabel,
  defaultLabel,
}) => {
  if (isRegistrationClosed) return REGISTRATION_CLOSED_LABEL;
  if (isSoldOut) return SOLD_OUT_LABEL;
  const custom = typeof perEventLabel === 'string' ? perEventLabel.trim() : '';
  return custom || defaultLabel;
};
