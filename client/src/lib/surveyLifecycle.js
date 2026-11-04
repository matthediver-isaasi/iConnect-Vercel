export const SURVEY_STATES = ["draft", "active", "paused", "closed", "archived"];

export function surveyLifecycleState(form) {
  const settings = form?.survey_settings || {};
  if (form?.archived_at) return "archived";
  if (SURVEY_STATES.includes(settings.lifecycle_state)) return settings.lifecycle_state;
  if (settings.status === "archived") return "archived";
  // Preserve disabled legacy surveys; never infer activation from a snapshot alone.
  if (form?.is_active === false) return "paused";
  if (settings.status === "published") return "active";
  return "draft";
}

export function assignmentIsRemoved(assignment) {
  return ["removed", "archived"].includes(assignment?.status);
}

export function surveyAssignmentCardClass(form, assignment) {
  if (assignmentIsRemoved(assignment)) return "border-red-200 bg-red-50";
  if (!form) return "border-slate-200 bg-white";
  const state = surveyLifecycleState(form);
  if (state === "active") return "border-green-200 bg-green-50";
  if (state === "draft") return "border-yellow-200 bg-yellow-50";
  return "border-slate-200 bg-slate-50";
}

export function surveyAvailability(form, assignment, now = Date.now()) {
  if (!form) return { available: false, label: "Availability unknown", reason: "Survey details could not be verified." };
  if (assignment && assignmentIsRemoved(assignment)) {
    return { available: false, label: "Removed from event", reason: "This event link is unavailable. The association and responses are retained." };
  }
  const state = surveyLifecycleState(form);
  const reasons = {
    draft: "This survey has not been activated for responses.",
    paused: "This survey is temporarily unavailable. Please try again later.",
    closed: "This survey is now closed and is no longer accepting responses.",
    archived: "This survey is no longer available for submissions.",
  };
  if (state !== "active") return { available: false, label: state[0].toUpperCase() + state.slice(1), reason: reasons[state] };
  if (!(Number(form.survey_settings?.current_version) > 0)) {
    return { available: false, label: "No published version", reason: "Publish a survey version before accepting responses." };
  }
  if (assignment && assignment.event_id == null && assignment.complex_event_id == null) {
    return { available: false, label: "Event unavailable", reason: "The original event is no longer available." };
  }
  if (assignment?.opens_at && Date.parse(assignment.opens_at) > now) {
    return { available: false, label: "Not open yet", reason: "The event response window has not opened." };
  }
  if (assignment?.closes_at && Date.parse(assignment.closes_at) <= now) {
    return { available: false, label: "Response window closed", reason: "The original closing date has passed. Restoring does not extend it." };
  }
  const membersOnly = assignment ? assignment.access_mode === "authenticated" : form.require_authentication;
  return { available: true, label: "Accepting responses", reason: membersOnly ? "Eligible signed-in members with a valid link can respond." : "Respondents with a valid link can respond." };
}

export const surveyActionLabels = {
  pause: "Pause Survey",
  close: "Close Survey",
  archive: "Archive Survey",
  restore: "Restore Survey",
  activate: "Activate Survey",
  delete: "Permanently Delete Survey",
  remove_assignment: "Remove from Event",
  reattach_assignment: "Reattach to Event",
  update_assignment: "Update Event Survey Access",
};

// Only state-derived, non-identifying copy belongs on a public unavailable page.
export function publicSurveyUnavailableMessage(state) {
  return {
    paused: "This survey is temporarily unavailable. Please try again later.",
    closed: "This survey is now closed and is no longer accepting responses.",
    archived: "This survey is no longer available for submissions.",
    removed: "This survey is no longer available for this event.",
    removed_assignment: "This survey is no longer available for this event.",
    draft: "This survey is not available for responses yet.",
  }[state] || "This survey is currently unavailable. Please check your link or contact the organiser.";
}
