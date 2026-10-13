// Archiving removes a form from configuration/selection, not its history.
export function isAvailableDueDiligenceForm(form) {
  return Boolean(form?.due_diligence_required && !form.archived_at);
}
