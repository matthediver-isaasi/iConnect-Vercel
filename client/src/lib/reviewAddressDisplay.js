import {
  ADDRESS_LOOKUP_COMPONENTS,
  normalizeAddressLookupAddress,
} from "../../../shared/formAddressLookup.js";

// Display only: never normalize or rewrite the persisted source answer.
export function formatReviewAddress(value) {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object') return formatReviewAddress(parsed);
    } catch {
      // Legacy free-text addresses remain readable.
    }
    return value.split(/\r?\n/).map(line => line.trim()).filter(Boolean).join('\n');
  }
  if (value == null) return '';
  const address = normalizeAddressLookupAddress(value);
  const lines = address && ADDRESS_LOOKUP_COMPONENTS.map(key => address[key]).filter(Boolean);
  if (lines?.length) {
    // Preserve readable legacy extras even when only part of the object uses
    // the current contract. Aliases already included above are not repeated.
    const extras = Object.values(value).map(formatReviewAddress).filter(text => text && !lines.includes(text));
    return [...lines, ...extras].join('\n');
  }
  // Unexpected legacy shapes must not turn a non-empty source into "No value".
  if (typeof value === 'object') {
    return Object.values(value).map(formatReviewAddress).filter(Boolean).join('\n');
  }
  return String(value);
}