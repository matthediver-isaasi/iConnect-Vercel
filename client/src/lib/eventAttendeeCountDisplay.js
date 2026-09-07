export function resolveEventAttendeeCountDisplay({
  count,
  isLoading = false,
  isError = false,
} = {}) {
  if (isLoading) {
    return {
      kind: 'loading',
      text: '…',
      ariaLabel: 'Attendee count loading',
    };
  }
  if (isError || !Number.isInteger(count) || count < 0) {
    return {
      kind: 'unavailable',
      text: '—',
      ariaLabel: 'Attendee count unavailable',
    };
  }
  return {
    kind: 'ready',
    text: String(count),
    ariaLabel: `Attendees: ${count}`,
  };
}