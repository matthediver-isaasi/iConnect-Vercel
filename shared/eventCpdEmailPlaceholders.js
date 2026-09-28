// Only these values are available in manual certificate emails. Optional data
// is blank; points are the booking's authoritative ledger total, not its award rule.
export const EVENT_CPD_EMAIL_PLACEHOLDERS = [
  ['attendee_name', 'Attendee name', 'Resolved attendee full name, including guests.'],
  ['attendee_first_name', 'Attendee first name', 'Resolved attendee first name.'],
  ['attendee_last_name', 'Attendee last name', 'Resolved attendee last name.'],
  ['attendee_email', 'Attendee email', 'The resolved attendee email destination.'],
  ['organisation_name', 'Attendee organisation', 'Booking organisation, when available.'],
  ['event_name', 'Event name', 'The booked event title.'],
  ['activity_date', 'Activity date', 'Certificate activity start date, formatted.'],
  ['activity_date_range', 'Activity date range', 'Effective certificate activity date range, including ticket date overrides.'],
  ['activity_start_date', 'Activity start date', 'Effective certificate start date (YYYY-MM-DD).'],
  ['activity_end_date', 'Activity end date', 'Effective certificate end date, blank when not supplied.'],
  ['cpd_points', 'Awarded CPD points', 'Authoritative booking ledger total including reversals; blank if no ledger entries exist. Never the configured award amount.'],
  ['event_survey_list', 'Event surveys', 'All currently eligible attached surveys. Sent emails include individual attendee booking links; previews show no access links.'],
].map(([key, label, description]) => ({ token: `{{${key}}}`, label, description }));