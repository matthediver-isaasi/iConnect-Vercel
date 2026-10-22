// UI validation/loading flags are not booking identity. A form remount must not
// silently create another spending attempt for the same submitted attendees.
export function programRegistrationIdentity(params) {
  return {
    registrationMode: params.registrationMode,
    numberOfLinks: params.registrationMode === 'links' ? Number(params.numberOfLinks) : 0,
    attendees: params.registrationMode === 'links' ? [] : (params.attendees || []).map(attendee => ({
      email: attendee.email || '',
      first_name: attendee.first_name || '',
      last_name: attendee.last_name || '',
      job_title: attendee.job_title?.trim() || null,
      dietary_selections: attendee.dietary_selections || null,
      allergy_selections: attendee.allergy_selections || null,
      accessibility_selections: attendee.accessibility_selections || null,
    })),
    ticketClassId: params.ticketClassId || null,
    thirdPartyConsent: params.thirdPartyConsent ?? null,
  };
}
