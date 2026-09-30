// Shared helper to coerce a wide variety of truthy/falsy inputs (Yes/No radios,
// booleans, 1/0, on/off, single-element arrays, { value } wrappers, etc.)
// into the canonical 'true' / 'false' strings that boolean preference
// fields are read as (value === true || value === 'true'). Returns null
// when the input doesn't clearly map to true or false — callers should
// treat that the same as an empty source value and skip the write rather
// than silently storing false.
export function coerceBooleanPreferenceValue(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (value === 1) return 'true';
    if (value === 0) return 'false';
    return null;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    if (value.length === 1) return coerceBooleanPreferenceValue(value[0]);
    return null;
  }
  if (typeof value === 'object') {
    if ('value' in value) return coerceBooleanPreferenceValue(value.value);
    if ('checked' in value) return coerceBooleanPreferenceValue(value.checked);
    return null;
  }
  const s = String(value).trim().toLowerCase();
  if (['true', 'yes', 'y', 'on', '1'].includes(s)) return 'true';
  if (['false', 'no', 'n', 'off', '0'].includes(s)) return 'false';
  return null;
}
