export const CPD_REPLAY_ENDPOINT = "/api/admin/event-cpd-points-replay";

// A UUID alone is not a registration identity: both booking tables may contain it.
export function cpdRegistrationIdentity(attendee, group) {
  return {
    booking_id: attendee.id,
    booking_source: group.bookingSource === "complex_event_booking" ? "complex" : "standard",
    event_id: group.eventId,
  };
}

export function cpdRegistrationKey(row) {
  return `${row.booking_source}:${row.event_id}:${row.booking_id}`;
}

export function canConfirmCpdPreview(preview, rows) {
  return preview?.complete === true && !!preview.preview_token
    && Number(preview.totals?.eligible) > 0
    && Number(preview.totals?.registrations) === rows.length
    && new Set(rows.map(cpdRegistrationKey)).size === rows.length
    && !rows.some(row => row.outcome === "evaluation_error");
}

export async function readCpdReplayResponse(response) {
  const data = await response.json().catch(() => null);
  if (!response.ok || !data) {
    const error = new Error(data?.error || `CPD points request failed (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return data;
}