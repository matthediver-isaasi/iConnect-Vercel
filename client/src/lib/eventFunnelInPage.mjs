// Pure helpers for running an event funnel over the source event page.
export const IN_PAGE_RESERVATION_PARAM = 'reservation';

// Ticket routing may list the mapped classes. Older responses without the list
// keep the previous behaviour: every class is checked at submission.
export function isTicketRoutedByEntry(entry, selectedTicketIds = []) {
  if (entry?.active !== true || entry.routing !== 'ticket' || entry.versionId) return true;
  if (!Array.isArray(entry.routedTicketIds)) return true;
  return selectedTicketIds.some(id => entry.routedTicketIds.includes(String(id)));
}

const attendeeKey = attendee => String(attendee?.email || '').trim().toLowerCase()
  || `${attendee?.first_name || ''} ${attendee?.last_name || ''}`.trim().toLowerCase();

// Everyone named at the source step, once each, in their original order.
export function sourceAttendeePool(sourceAnswers) {
  const groups = sourceAnswers?.attendeesByTicket && typeof sourceAnswers.attendeesByTicket === 'object'
    ? Object.values(sourceAnswers.attendeesByTicket) : [sourceAnswers?.attendees || []];
  const seen = new Set();
  const pool = [];
  for (const attendee of groups.flat()) {
    if (!attendee || typeof attendee !== 'object') continue;
    const key = attendeeKey(attendee);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    pool.push(attendee);
  }
  return pool;
}

// Saved add-on choices as { ticketId: [poolIndex] }.
export function restoreAddonChoices(pool, offer) {
  const byTicket = offer?.draft?.answers?.attendeesByTicket || {};
  return Object.fromEntries((offer?.selectedTickets || []).map(selection => {
    const id = String(selection.id);
    const keys = new Set((byTicket[id] || []).map(attendeeKey));
    const chosen = pool.map((attendee, index) => keys.has(attendeeKey(attendee)) ? index : -1).filter(index => index >= 0);
    return [id, chosen.length ? chosen : pool.slice(0, Number(selection.quantity) || 0).map((_, index) => index)];
  }));
}

// Re-uses the source step's purchaser, terms and conduct acceptance so the
// add-on passes the same server checks; only the tickets and attendees change.
export function addonSelection(sourceAnswers, pool, choices) {
  const { attendeesByTicket: ignoredByTicket, attendees: ignoredAttendees, ...shared } = sourceAnswers || {};
  void ignoredByTicket; void ignoredAttendees;
  const entries = Object.entries(choices)
    .map(([id, indexes]) => [id, [...new Set(indexes)].sort((a, b) => a - b).map(index => pool[index]).filter(Boolean)])
    .filter(([, attendees]) => attendees.length);
  const attendeesByTicket = Object.fromEntries(entries);
  return {
    tickets: entries.map(([id, attendees]) => ({ id, quantity: attendees.length })),
    answers: { ...shared, attendeesByTicket, ...(entries.length === 1 ? { attendees: entries[0][1] } : {}) },
  };
}
