const NUMERIC_FIELD_TYPES = ['number', 'integer', 'decimal', 'numeric', 'currency'];
const TEXT_FIELD_TYPES = ['text', 'textarea', 'long_text', 'string', 'select', 'dropdown', 'radio', 'picklist'];

export function isNumericFieldType(fieldType) {
  return NUMERIC_FIELD_TYPES.includes(String(fieldType || '').toLowerCase());
}

export function isTextFieldType(fieldType) {
  return TEXT_FIELD_TYPES.includes(String(fieldType || '').toLowerCase());
}

export function bandsAreTextBasis(bands) {
  if (!bands?.length) return false;
  return bands.some(b => b && b.match_value != null && String(b.match_value).trim() !== '');
}

export function normalizeMatchValue(v) {
  if (v == null) return '';
  return String(v).trim().toLowerCase();
}

export function matchBand(fieldValue, bands) {
  if (fieldValue === null || fieldValue === undefined || !bands?.length) return null;

  if (bandsAreTextBasis(bands)) {
    const norm = normalizeMatchValue(fieldValue);
    if (!norm) return null;
    for (const band of bands) {
      if (band.match_value != null && normalizeMatchValue(band.match_value) === norm) {
        return band;
      }
    }
    return null;
  }

  const numeric = typeof fieldValue === 'number' ? fieldValue : parseFloat(fieldValue);
  if (isNaN(numeric)) return null;

  for (const band of bands) {
    const min = parseFloat(band.min_value);
    const max = band.max_value !== null && band.max_value !== undefined ? parseFloat(band.max_value) : Infinity;
    if (!isNaN(min) && numeric >= min && numeric <= max) {
      return band;
    }
  }
  return null;
}
