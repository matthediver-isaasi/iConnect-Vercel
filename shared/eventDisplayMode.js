export const EVENT_DISPLAY_MODES = Object.freeze([
  'hidden',
  'collapsed',
  'expanded',
]);

export const EVENT_DISPLAY_MODE_FIELDS = Object.freeze([
  'speaker_display_mode',
  'sponsor_display_mode',
]);

const EVENT_DISPLAY_MODE_SET = new Set(EVENT_DISPLAY_MODES);

export function normalizeEventDisplayMode(value) {
  return EVENT_DISPLAY_MODE_SET.has(value) ? value : 'expanded';
}

export function validateEventDisplayModePayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  for (const field of EVENT_DISPLAY_MODE_FIELDS) {
    if (
      Object.prototype.hasOwnProperty.call(payload, field)
      && !EVENT_DISPLAY_MODE_SET.has(payload[field])
    ) {
      return {
        error: `${field} must be one of: ${EVENT_DISPLAY_MODES.join(', ')}`,
        code: 'INVALID_EVENT_DISPLAY_MODE',
        field,
      };
    }
  }
  return null;
}