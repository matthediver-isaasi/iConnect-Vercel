/** Legacy Zoom rows can only carry one booking id; never choose arbitrarily. */
export function legacyBookingMatch(candidates) {
  return candidates?.length === 1 ? candidates[0] : null;
}