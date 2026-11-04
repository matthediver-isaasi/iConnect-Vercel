export function surveyLifecycleState(form) {
  if (form.archived_at) return 'archived';
  const saved = form.survey_settings?.lifecycle_state;
  if (['draft','active','paused','closed','archived'].includes(saved)) return saved;
  if (form.survey_settings?.status === 'archived') return 'archived';
  if (form.is_active === false) return 'paused';
  if (form.survey_settings?.status === 'published') return 'active';
  return 'draft';
}
export function surveyUnavailable(state) {
  return { errorstate: state, unavailable_state: state, error: {
    paused: 'This survey is temporarily unavailable. Please try again later.',
    closed: 'This survey is now closed and is no longer accepting responses.',
    archived: 'This survey is no longer available for submissions.',
    draft: 'This survey is not yet available for submissions.',
  }[state] || 'This survey is not accepting responses.' };
}
