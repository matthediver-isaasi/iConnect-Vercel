// Compare persisted reminder settings, not UI-only state or updated_at.
// Confirmation edits must not reschedule every booking on the event.
export function reminderConfigurationsChanged(before, after) {
  const fingerprint = rows => JSON.stringify(rows
    .filter(row => row.email_type === 'reminder')
    .map(row => ({
      id: row.id,
      timing: row.timing_type || null,
      hours: row.custom_hours_before == null ? null : String(row.custom_hours_before),
      unit: row.custom_unit || null,
      sendAt: row.custom_send_at ? new Date(row.custom_send_at).toISOString() : null,
      subject: row.subject || '',
      body: row.body || '',
      cc: row.cc || '',
      enabled: row.is_enabled !== false,
      complex: row.is_complex_event === true,
      survey: row.event_survey_assignment_id || null,
    }))
    .sort((a, b) => String(a.id).localeCompare(String(b.id))));
  return fingerprint(before) !== fingerprint(after);
}
