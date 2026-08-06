/**
 * TBC events: "Replace standard booking elements".
 *
 * For events whose timing is To Be Confirmed (status === 'tbc') admins can
 * toggle replace_booking_elements and supply a helper message plus a CTA
 * button label. On public detail pages the ticket price / booking summary
 * displays are replaced by the helper message card and the confirm button
 * (label overridden). The booking action itself, attendee inputs, ticket
 * selection and terms & conditions enforcement are unchanged.
 */

/**
 * Returns `{ message, ctaLabel }` when the replacement applies to this
 * event, otherwise null. Only TBC events with the flag explicitly true
 * qualify — every other event is completely unaffected.
 */
export function getTbcBookingReplacement(event) {
  if (!event || event.status !== 'tbc' || event.replace_booking_elements !== true) {
    return null;
  }
  return {
    message: event.booking_replacement_message || '',
    ctaLabel: (event.booking_replacement_cta_label || '').trim() || null,
  };
}

/**
 * Whether the price/summary display should actually be suppressed.
 * The replacement targets free pre-registration: when money is still owed
 * (totalCost > 0) the pricing/payment section must remain visible so the
 * booking can be paid for.
 */
export function isTbcReplacementDisplayActive(replacement, totalCost = 0) {
  return !!replacement && !(Number(totalCost) > 0);
}

/**
 * Confirm-button label with the optional override applied.
 */
export function resolveTbcCtaLabel(replacement, fallback = 'Confirm Booking') {
  return replacement?.ctaLabel || fallback;
}
