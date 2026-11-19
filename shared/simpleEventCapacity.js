export function hasUnlimitedEventCapacity(event) {
  if (event?.is_complex) return event.available_seats === 0 || event.available_seats === null;
  if (event?.capacity_mode === 'total' && !event.is_complex) return event.total_capacity === null;
  if (event?.is_unlimited_registration !== undefined) return event.is_unlimited_registration === true;
  return event?.available_seats === 0 || event?.available_seats === null;
}
