// Shared storage coercion for preference values written by the form
// pipeline (api/forms/process-application.js).
//
// - Boolean-typed fields are canonicalised to the 'true'/'false' strings
//   all boolean readers expect (value === 'true') via the shared
//   booleanCoercion helper — Yes/No radios, 1/0, on/off, checkbox arrays,
//   { value } wrappers etc. Ambiguous inputs return `undefined`, meaning
//   the caller must SKIP the write entirely rather than silently storing a
//   string that reads as false.
// - Arrays/objects are JSON-stringified; other scalars are stringified.
import { coerceBooleanPreferenceValue } from './booleanCoercion.js';

export function coercePreferenceValueForStorage(value, prefField) {
  if (prefField?.field_type === 'boolean') {
    const coerced = coerceBooleanPreferenceValue(value);
    if (coerced === null) {
      console.log('[AppProcessor] Skipping boolean preference write - value did not coerce:', { field_id: prefField.id, value });
      return undefined;
    }
    return coerced;
  }
  if (Array.isArray(value) || (value !== null && typeof value === 'object')) {
    return JSON.stringify(value);
  }
  return String(value);
}
