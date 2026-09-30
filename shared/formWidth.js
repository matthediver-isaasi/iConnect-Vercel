const FORM_WIDTH_MAX_VALUES = Object.freeze({
  narrow: '48rem',
  medium: '64rem',
  wide: '80rem',
});

const DEFAULT_FORM_WIDTH = 'narrow';
const INVALID_FORM_WIDTH_ERROR = 'form_width must be one of: narrow, medium, wide';

/**
 * Return whether a value is one of the supported form width presets.
 *
 * This intentionally does not coerce values. API writes should reject invalid
 * enum values rather than silently changing what the caller requested.
 */
export function isValidFormWidth(value) {
  return typeof value === 'string'
    && Object.prototype.hasOwnProperty.call(FORM_WIDTH_MAX_VALUES, value);
}

/**
 * Normalize a persisted or API-provided width for read-time use.
 *
 * Legacy rows predate this setting, so missing, null, and invalid values all
 * retain the existing narrow presentation.
 */
export function normalizeFormWidth(value) {
  return isValidFormWidth(value) ? value : DEFAULT_FORM_WIDTH;
}

/**
 * Validate a generic Form mutation payload.
 *
 * Returning null for an omitted property preserves compatibility with older
 * callers and lets the database default new rows to narrow.
 */
export function validateFormWidthPayload(payload) {
  if (!payload
    || typeof payload !== 'object'
    || Array.isArray(payload)
    || !Object.prototype.hasOwnProperty.call(payload, 'form_width')) {
    return null;
  }
  if (isValidFormWidth(payload.form_width)) return null;
  return {
    error: INVALID_FORM_WIDTH_ERROR,
    code: 'INVALID_FORM_WIDTH',
  };
}

/**
 * Resolve the value exposed by public form projections. This keeps all public
 * read paths consistent for legacy rows and any pre-constraint data.
 */
export function getPublicFormWidth(form) {
  return normalizeFormWidth(form?.form_width);
}

/**
 * Resolve the CSS max-width used by the form renderer.
 */
export function getFormMaxWidth(value) {
  return FORM_WIDTH_MAX_VALUES[normalizeFormWidth(value)];
}