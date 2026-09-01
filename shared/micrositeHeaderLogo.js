const LOGO_DIMENSION_KEYS = ['logoHeight', 'logoWidth', 'logoScrolledHeight'];
export const DEFAULT_HEADER_LOGO_HEIGHT = 158;

/**
 * Header logo dimensions are stored as positive integer pixel values. Empty
 * values intentionally mean "inherit the tenant setting".
 */
export function normalizePositiveLogoDimension(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    return Number.isInteger(value) && value > 0 ? value : null;
  }
  const raw = String(value).trim();
  if (!raw) return null;
  if (!/^\d+$/.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Validate the four header-logo controls while retaining inheritance
 * semantics. A scrolled height may be compared against a local full height or
 * the tenant's full height when the microsite leaves its own height empty.
 */
export function validateMicrositeHeaderLogoConfig(config, tenantHeaderConfig = {}) {
  const source = config && typeof config === 'object' && !Array.isArray(config) ? config : {};
  const tenant = tenantHeaderConfig && typeof tenantHeaderConfig === 'object'
    ? tenantHeaderConfig
    : {};
  const values = {};

  for (const key of LOGO_DIMENSION_KEYS) {
    if (source[key] === undefined || source[key] === null || String(source[key]).trim() === '') {
      values[key] = null;
      continue;
    }
    const normalized = normalizePositiveLogoDimension(source[key]);
    if (normalized === null) {
      return {
        ok: false,
        error: `${key} must be a positive whole number of pixels`,
      };
    }
    values[key] = normalized;
  }

  const shrinkIsEmpty = source.logoShrinkOnScroll === null
    || source.logoShrinkOnScroll === undefined
    || source.logoShrinkOnScroll === '';
  if (!shrinkIsEmpty && typeof source.logoShrinkOnScroll !== 'boolean') {
    return { ok: false, error: 'logoShrinkOnScroll must be a boolean' };
  }
  if (!shrinkIsEmpty) {
    values.logoShrinkOnScroll = source.logoShrinkOnScroll;
  }

  const fullHeight = values.logoHeight
    ?? normalizePositiveLogoDimension(tenant.logoHeight)
    ?? DEFAULT_HEADER_LOGO_HEIGHT;
  if (values.logoScrolledHeight !== null && values.logoScrolledHeight > fullHeight) {
    return {
      ok: false,
      error: 'logoScrolledHeight cannot be larger than logoHeight',
    };
  }

  return { ok: true, values };
}

export { LOGO_DIMENSION_KEYS };