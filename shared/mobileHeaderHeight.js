export const DEFAULT_MOBILE_HEADER_HEIGHT = 64;
export const MOBILE_HEADER_HEIGHT_ERROR =
  'Mobile header height must be a whole number between 64 and 200 pixels.';

export function validateMobileHeaderHeight(value) {
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) {
    return { ok: true, value: null };
  }

  const normalized = typeof value === 'string' ? Number(value.trim()) : value;
  if (!Number.isInteger(normalized) || normalized < 64 || normalized > 200) {
    return { ok: false, error: MOBILE_HEADER_HEIGHT_ERROR };
  }

  return { ok: true, value: normalized };
}

export function resolveMobileHeaderHeight(value) {
  const result = validateMobileHeaderHeight(value);
  return result.ok && result.value !== null ? result.value : DEFAULT_MOBILE_HEADER_HEIGHT;
}