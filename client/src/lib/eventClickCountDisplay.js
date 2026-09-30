export function resolveEventClickCountDisplay({
  count,
  isLoading = false,
  isError = false,
} = {}) {
  if (isLoading) {
    return {
      kind: 'loading',
      text: '…',
      ariaLabel: 'Event click count loading',
    };
  }
  if (isError || !Number.isInteger(count) || count < 0) {
    return {
      kind: 'unavailable',
      text: '—',
      ariaLabel: 'Event click count unavailable',
    };
  }
  return {
    kind: 'ready',
    text: String(count),
    ariaLabel: `Event clicks: ${count}`,
  };
}