export function buildActiveAttendeeCountMap(bookings, eventIds = []) {
  const counts = Object.fromEntries(eventIds.map((eventId) => [eventId, 0]));

  for (const booking of bookings || []) {
    if (!booking?.event_id || booking.status === 'cancelled') continue;
    if (!Object.prototype.hasOwnProperty.call(counts, booking.event_id)) continue;
    counts[booking.event_id] += 1;
  }

  return counts;
}

export async function fetchEventAttendeeCounts({ simpleEventIds = [], complexEventIds = [] }) {
  const taggedEventIds = [
    ...simpleEventIds.map((id) => ({ id, kind: 'simple' })),
    ...complexEventIds.map((id) => ({ id, kind: 'complex' })),
  ];
  const batches = [];
  for (let index = 0; index < taggedEventIds.length; index += 500) {
    batches.push(taggedEventIds.slice(index, index + 500));
  }

  const responses = await Promise.all(batches.map(async (events) => {
    const response = await fetch('/api/admin/events/attendee-counts', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        simpleEventIds: events.filter((event) => event.kind === 'simple').map((event) => event.id),
        complexEventIds: events.filter((event) => event.kind === 'complex').map((event) => event.id),
      }),
    });
    if (!response.ok) throw new Error('Failed to load attendee counts');
    const data = await response.json();
    return data.counts || {};
  }));

  return Object.assign({}, ...responses);
}