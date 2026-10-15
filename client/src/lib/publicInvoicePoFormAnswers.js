import {
  formatRelationshipAnswerDisplayValue,
  getSubmissionFieldValue,
  isRelationshipDropdownField,
} from "@/lib/relationshipDisplayLabels";

export const normalizeSubmissionEmail = value => typeof value === "string" ? value.trim().toLowerCase() : "";
const isEmail = value => typeof value === "string" && /\S+@\S+\.\S+/.test(value.trim());

export function extractSubmissionEmail(submission, fields) {
  if (isEmail(submission?.submitted_by_email)) return submission.submitted_by_email.trim();
  const data = submission?.submission_data || {};
  for (const field of fields || []) {
    if (!field?.id) continue;
    if (field.type === "email" || /e-?mail/i.test(`${field.id} ${field.label}`)) {
      const value = getSubmissionFieldValue(data, field);
      if (isEmail(value)) return value.trim();
    }
  }
  return Object.values(data).find(isEmail)?.trim() || null;
}

export function formatLinkedAnswer(value) {
  if (value == null) return "";
  if (Array.isArray(value)) return value.map(formatLinkedAnswer).filter(Boolean).join(", ");
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "object") {
    if (value.name) return value.severity ? `${value.name} (${value.severity})` : value.name;
    if (value.label) return value.label;
    if (value.file_url) return String(value.file_url);
    return JSON.stringify(value);
  }
  return String(value);
}

export function submissionAnswer(field, data, labels) {
  const value = getSubmissionFieldValue(data, field);
  return isRelationshipDropdownField(field)
    ? formatRelationshipAnswerDisplayValue(field, value, labels, data)
    : formatLinkedAnswer(value);
}

// The report endpoint supplies the form definition with each submission so
// report-only viewers do not need permission to list unrelated forms.
export function submissionForm(submission, formsById = {}) {
  return formsById[submission.form_id] || submission.form || {
    title: submission.form_title,
    fields: submission.form_fields || submission.fields || [],
    related_event_id: submission.event_id,
  };
}
