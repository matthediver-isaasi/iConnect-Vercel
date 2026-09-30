export const EMPTY_TEAMS_MEETING = Object.freeze({
  teams_online_meeting_id: null,
  teams_join_web_url: null,
  teams_organiser_microsoft_user_id: null,
  teams_organiser_email: null,
  teams_outlook_connection_id: null,
  teams_meeting_lifecycle: null,
});

export function normalizeTeamsMeeting(source = {}) {
  return {
    teams_online_meeting_id: source.teams_online_meeting_id || source.onlineMeetingId || source.id || null,
    teams_join_web_url: source.teams_join_web_url || source.joinWebUrl || source.join_url || null,
    teams_organiser_microsoft_user_id: source.teams_organiser_microsoft_user_id
      || source.organiserMicrosoftUserId || source.organizerId || source.organizer?.identity?.user?.id || null,
    teams_organiser_email: source.teams_organiser_email || source.organiserEmail || source.organizerEmail
      || source.organizer?.upn || source.organizer?.identity?.user?.email || null,
    teams_outlook_connection_id: source.teams_outlook_connection_id || source.connectionId || null,
    teams_meeting_lifecycle: source.teams_meeting_lifecycle || source.lifecycle || 'active',
  };
}

export function hasTeamsMeeting(source = {}) {
  const meeting = normalizeTeamsMeeting(source);
  return Boolean(meeting.teams_online_meeting_id && meeting.teams_join_web_url
    && meeting.teams_organiser_microsoft_user_id && meeting.teams_outlook_connection_id);
}

export function clearTeamsMeeting() {
  return { ...EMPTY_TEAMS_MEETING };
}
