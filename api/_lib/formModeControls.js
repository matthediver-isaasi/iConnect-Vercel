// Keep dormant standard-form settings for mode switching, but never let them
// override a survey's published response policy or server-resolved assignment.
export function usesStandardEmailLimit(form) {
  return form?.form_type !== 'survey' && form?.prevent_duplicate_email_submission === true;
}

export function submissionEventContext(form, assignment = null) {
  if (form?.form_type === 'survey') {
    if (!assignment) return {};
    return {
      survey_assignment_id: assignment.id,
      ...(assignment.event_type === 'event' && assignment.event_id
        ? { event_id: assignment.event_id } : {}),
      ...(assignment.event_type === 'complex_event' && assignment.complex_event_id
        ? { complex_event_id: assignment.complex_event_id } : {}),
    };
  }
  return form?.is_event_related && form?.related_event_id
    ? { event_id: form.related_event_id } : {};
}
