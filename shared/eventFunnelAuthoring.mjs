const unavailableStates = new Set(['completed', 'complete', 'cancelled', 'canceled', 'past', 'archived']);

// Authoring choices require a known future start. Undated/TBC and already
// started events are retained in saved catalogs, but cannot be newly selected.
export function isFutureFunnelEvent(event, now = Date.now()) {
  if (!event || [event.status, event.event_state].some(state =>
    unavailableStates.has(String(state || '').toLowerCase()))) return false;
  const start = Date.parse(event.start_date || '');
  return Number.isFinite(start) && start > Number(now);
}

export function sortFunnelCatalog(catalog) {
  return [...catalog].sort((a, b) =>
    String(a.title || '').localeCompare(String(b.title || ''), 'en', { sensitivity: 'base', numeric: true })
    || String(a.kind).localeCompare(String(b.kind)) || String(a.id).localeCompare(String(b.id)));
}
