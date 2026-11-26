import { normalizeDuplicateDynamicTokens } from '../components/email-builder/types.js';

// Compare authored values, not derived HTML, recipient previews or UI controls.
// Object key order and audience selection order have no persistence meaning.
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
}

export function campaignEditorSnapshot({ formData, directAudienceType, selectedAudienceIds,
  scheduleMode, reviewSelections, reviewConfirmed }) {
  const { html_content } = formData;
  const fields = Object.fromEntries([
    'name', 'subject', 'from_name', 'from_email', 'reply_to', 'email_template_id',
    'design_json', 'event_survey_context', 'deliver_to_inbox_when_opted_out',
    'communication_category_id', 'scheduled_at', 'is_test_mode',
  ].map(key => [key, formData[key]]));
  // Opening the builder may repair legacy duplicate tokens; that is hydration,
  // not an authored edit. The save path already persists the same repair.
  if (fields.design_json) fields.design_json = normalizeDuplicateDynamicTokens(fields.design_json).design;
  return JSON.stringify(canonical({
    ...fields,
    email_template_id: fields.email_template_id || null,
    communication_category_id: fields.communication_category_id || null,
    // Visual HTML can change when the footer or compiler changes, without edits.
    html_content: fields.design_json ? null : html_content,
    audience: { type: directAudienceType, ids: [...selectedAudienceIds].sort() },
    scheduleMode,
    reviewSelections,
    reviewConfirmed,
  }));
}
