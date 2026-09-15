// Shared by membership discount and VAT rules. Keep invalid selections
// non-matching for both equals and not-equals.
function normalizeSelections(value) {
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return [];
    try {
      const parsed = JSON.parse(text);
      value = typeof parsed === 'object' ? parsed : text;
    } catch {
      // Broken serialized selections must not activate a not-equals rule.
      if (/^[\[{"]/.test(text)) return [];
      value = text;
    }
  }
  const selections = Array.isArray(value) ? value : [value];
  // Reject objects/nested arrays rather than coercing them into matchable text.
  if (selections.some(v => v != null && !['string', 'number', 'boolean'].includes(typeof v))) return [];
  return selections
    .filter(v => v != null)
    .map(v => String(v).trim().toLowerCase())
    .filter(Boolean);
}

export function matchesSelections(value, matchValue, condition) {
  const selections = normalizeSelections(value);
  const configuredSelections = normalizeSelections(matchValue);
  if (!selections.length || !configuredSelections.length) return false;
  const anyMatch = selections.some(v => configuredSelections.includes(v));
  return condition === 'not_equals' ? !anyMatch : anyMatch;
}