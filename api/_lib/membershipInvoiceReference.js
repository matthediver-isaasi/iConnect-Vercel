const PLACEHOLDER_VALUES = new Set([
  'n/a',
  'na',
  'none',
  'nil',
  'not applicable',
  'no po',
  'no-po',
  'nopo',
  'no po number',
  'tbc',
  'tbd',
  'pending',
  'awaiting po',
  'awaiting',
  'po to follow',
  'po-to-follow',
  'tofollow',
  'to follow',
  '-',
  '--',
  '0',
]);

export const MEMBERSHIP_INVOICE_PO_FALLBACK = 'TBC';

function isPlaceholder(value) {
  if (!value) return true;
  const normalized = value.toLowerCase().replace(/\s+/g, ' ').trim();
  if (PLACEHOLDER_VALUES.has(normalized)) return true;
  return /^(?:tbc|tbd|pending|awaiting(?: po)?|po to follow)(?:\s*[-–—:]\s*.*)?$/i.test(normalized);
}

/**
 * Membership invoice provider fields contain a genuine PO number, or exactly
 * "TBC". Older callers may still supply the historical
 * "Membership <year> - PO: <value>" shape, so unwrap it at the provider seam.
 */
export function resolveMembershipInvoiceReference(reference) {
  const value = typeof reference === 'string' ? reference.trim() : '';
  if (!value) return MEMBERSHIP_INVOICE_PO_FALLBACK;

  const embeddedPo = value.match(/(?:^|[\s\-–—])PO:\s*(.*)$/i);
  if (embeddedPo) {
    const po = embeddedPo[1].trim();
    return isPlaceholder(po) ? MEMBERSHIP_INVOICE_PO_FALLBACK : po;
  }

  // Only collapse the exact legacy description shape. A genuine PO is free
  // text and may itself begin with "Membership".
  const legacyMembershipDescription =
    /^membership\s+\d{4}(?:\s*[\/-]\s*\d{2,4})?$/i.test(value);
  if (legacyMembershipDescription || isPlaceholder(value)) {
    return MEMBERSHIP_INVOICE_PO_FALLBACK;
  }

  return value;
}