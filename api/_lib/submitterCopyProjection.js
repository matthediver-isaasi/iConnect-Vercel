import { computeAuthoritativeHiddenFieldIds } from './formFieldVisibility.js';
import { rulesUseLmicOperators } from './formLmicConditions.js';
import { loadTenantLmicCodes } from './tenantLmicCodes.js';
import {
  effectiveRepeatableRowAnswers,
  getRepeatableRowHiddenChildIds,
  isRepeatableRowField,
} from '../../shared/formRepeatableRows.js';
import { FORM_NOT_LISTED_LABELS_KEY, FORM_NOT_LISTED_TEXT_KEY } from '../../shared/formNotListedChoice.js';

// Only this consumer uses this projection. Never replace the saved answers or
// evaluate conditions against the projected (incomplete) answer universe.
export async function prepareSubmitterCopy({ db, form, submission, visibilityOptions }) {
  if (submission.form_id !== form.id || submission.tenant_id !== form.tenant_id) {
    throw new Error('Submission does not belong to this form');
  }
  if (submission.survey_version_id) {
    const { data: version, error } = await db.from('survey_version')
      .select('fields, pages, visibility_rules')
      .eq('id', submission.survey_version_id).eq('form_id', form.id)
      .eq('tenant_id', form.tenant_id).maybeSingle();
    if (error || !version) throw new Error('Submission form version unavailable');
    form = { ...form, ...version };
  } else if (form.form_type === 'survey') {
    throw new Error('Submission form version unavailable');
  }
  // Match the export formatter's legacy nested configuration support.
  form = { ...form, fields: (form.fields || []).map(field =>
    isRepeatableRowField(field) && field.config && !field.repeatable_row
      ? { ...field, repeatable_row: field.config } : field) };
  const options = { ...visibilityOptions };
  if (rulesUseLmicOperators(form.visibility_rules) && !options.lmicCodes) {
    options.lmicCodes = await loadTenantLmicCodes(db, form.tenant_id, { strict: true });
  }
  const raw = submission.submission_data || {};
  const hidden = await computeAuthoritativeHiddenFieldIds({
    db, tenantId: form.tenant_id, form, formValues: raw, visibilityOptions: options,
  });
  const fields = (form.fields || []).filter(field => !hidden.has(field.id) && !hidden.has(String(field.id)));
  const data = {};
  const rowHidden = new Map();
  for (const field of fields) {
    const key = raw[field.id] !== undefined ? field.id : field.name;
    if (key && Object.hasOwn(raw, key)) {
      data[field.id] = raw[key];
      if (isRepeatableRowField(field)) {
        rowHidden.set(String(field.id), (Array.isArray(raw[key]) ? raw[key] : [])
          .map(row => getRepeatableRowHiddenChildIds(field, row, { hiddenFieldIds: hidden })));
        data[field.id] = effectiveRepeatableRowAnswers(field, raw[key], { hiddenFieldIds: hidden });
      }
    }
  }
  for (const key of [FORM_NOT_LISTED_LABELS_KEY, FORM_NOT_LISTED_TEXT_KEY]) {
    if (raw[key] && typeof raw[key] === 'object') {
      data[key] = Object.fromEntries(Object.entries(raw[key])
        .filter(([id]) => fields.some(field => String(field.id) === id)));
    }
  }
  // The submission endpoint can derive this metadata from an answer. Do not
  // reintroduce a hidden email through the standard metadata row.
  const hiddenEmail = (form.fields || []).some(field => {
    if (!hidden.has(field.id) && !hidden.has(String(field.id))) return false;
    const value = raw[field.id] !== undefined ? raw[field.id] : raw[field.name];
    return typeof value === 'string' && submission.submitted_by_email
      && value.trim().toLowerCase() === submission.submitted_by_email.trim().toLowerCase();
  });
  return {
    form: { ...form, fields },
    submission: { ...submission, submitted_by_email: hiddenEmail ? null : submission.submitted_by_email, submission_data: data },
    includeRepeatableCell: (field, child, rowIndex) =>
      !rowHidden.get(String(field.id))?.[rowIndex]?.has(String(child.id)),
  };
}
