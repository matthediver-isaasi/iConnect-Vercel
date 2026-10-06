/**
 * Format persisted answers, not calculated scores. Accept the documented
 * survey scalar forms without Number() coercing booleans/arrays/whitespace
 * into invented answers. Do not validate against the current form's range:
 * it may have changed since the answer was saved.
 */
export function formatScoreCsvAnswer(value) {
  if (typeof value === 'string' && value.trim().toUpperCase() === 'NA') return 'Not applicable';
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if (value.na === true) return 'Not applicable';
    value = value.score;
  }
  if (typeof value === 'string') {
    value = value.trim();
    if (!value) return '';
  }
  if (typeof value !== 'number' && typeof value !== 'string') return '';
  const score = Number(value);
  return Number.isInteger(score) ? String(score) : '';
}
