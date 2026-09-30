import { coerceBooleanPreferenceValue } from '../_lib/booleanCoercion.js';

export function prepareMemberCustomPreferenceValue(value, prefField) {
  if (value === undefined || value === null || value === '') {
    return { ok: false, reason: 'unresolved_input' };
  }
  if (!prefField) {
    return { ok: false, reason: 'missing_preference_definition' };
  }
  if (prefField.field_type === 'boolean') {
    const storedValue = coerceBooleanPreferenceValue(value);
    if (storedValue === null) {
      return { ok: false, reason: 'unsupported_boolean_coercion' };
    }
    return { ok: true, storedValue };
  }
  return {
    ok: true,
    storedValue: typeof value === 'object' ? JSON.stringify(value) : String(value),
  };
}