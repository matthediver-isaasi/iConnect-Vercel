export function resolveEventAttendeeCountDisplay({
  count,
  isLoading = false,
  isError = false,
  waitingList = false,
} = {}) {
  if (isLoading) {
    return {
      kind: 'loading',
      text: '…',
      ariaLabel: waitingList ? 'Waiting list count loading' : 'Attendee count loading',
    };
  }
  if (isError || !Number.isInteger(count) || count < 0) {
    return {
      kind: 'unavailable',
      text: '—',
      ariaLabel: waitingList ? 'Waiting list count unavailable' : 'Attendee count unavailable',
    };
  }
  return {
    kind: 'ready',
    text: String(count),
    ariaLabel: `${waitingList ? 'Waiting list' : 'Attendees'}: ${count}`,
  };
}