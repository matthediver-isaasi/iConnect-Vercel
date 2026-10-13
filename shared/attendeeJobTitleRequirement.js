export const ATTENDEE_JOB_TITLE_KEY = 'require_attendee_job_title';

export function requireAttendeeJobTitle(settings) {
  return Array.isArray(settings) && settings.some(row =>
    row.setting_key === ATTENDEE_JOB_TITLE_KEY &&
    (row.setting_value === 'true' || row.setting_value === true));
}

export function missingAttendeeJobTitle(attendees) {
  const index = (attendees || []).findIndex(a =>
    typeof a?.job_title !== 'string' || !a.job_title.trim());
  if (index < 0) return null;
  const attendee = attendees[index];
  const name = [attendee?.first_name, attendee?.last_name].filter(Boolean).join(' ');
  return `Please enter a job title for attendee ${index + 1}${name ? ` (${name})` : ''}.`;
}
