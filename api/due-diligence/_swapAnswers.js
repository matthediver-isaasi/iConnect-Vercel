import { createFormRelationshipService, FormRelationshipError } from '../_lib/formRelationshipOptions.js';
import { computeAuthoritativeHiddenFieldIds } from '../_lib/formFieldVisibility.js';
import { rulesUseLmicOperators } from '../_lib/formLmicConditions.js';
import { loadTenantLmicCodes } from '../_lib/tenantLmicCodes.js';
import { validateFutureDateFields } from '../../shared/formFutureDates.js';
import { isRepeatableRowField, repeatableRowChildren } from '../../shared/formRepeatableRows.js';

const own = (data, key) => key != null && Object.hasOwn(data || {}, key);
const label = field => String(field.label || '').trim().toLowerCase();
const populated = value => value != null && value !== '' && !(Array.isArray(value) && !value.length);
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value);

export function layerAnswer(data, field) {
  for (const key of [field.id, field.label]) {
    if (own(data, key)) return { present: true, value: data[key] };
  }
  return { present: false };
}

export function swapSourceAnswer(submission, field) {
  for (const data of [
    submission.reviewed_form_values,
    submission.original_form_values,
    submission.form_submission?.submission_data,
  ]) {
    const answer = layerAnswer(data, field);
    if (answer.present) return answer;
  }
  return { present: false };
}

const textTypes = new Set(['text', 'textarea', 'long_text']);
function compatible(source, target, value) {
  if (!populated(value)) return true;
  // Use the same alias/nested-schema resolution as the renderer. A label match
  // cannot translate child answer keys, even when both containers are rows.
  if (isRepeatableRowField(source) || isRepeatableRowField(target)) {
    return isRepeatableRowField(source) && isRepeatableRowField(target)
      && Array.isArray(value)
      && JSON.stringify(repeatableRowChildren(source)) === JSON.stringify(repeatableRowChildren(target));
  }
  if ([...textTypes, 'email'].includes(source.type) && target.type === 'email') {
    return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  }
  if (source.type === 'email' && textTypes.has(target.type)) return typeof value === 'string';
  if (source.type !== target.type && !(textTypes.has(source.type) && textTypes.has(target.type))) return false;
  if (textTypes.has(target.type)) return typeof value === 'string';
  if (['number', 'integer', 'decimal', 'percentage'].includes(target.type)) {
    return (typeof value === 'number' || typeof value === 'string')
      && Number.isFinite(Number(value))
      && (target.type !== 'integer' || Number.isInteger(Number(value)));
  }
  if (['email', 'url', 'date', 'time', 'country', 'phone', 'tel'].includes(target.type)) return typeof value === 'string';
  if (['select', 'radio', 'dropdown'].includes(target.type) && target.options?.length) {
    const options = target.options.map(option => String(
      option && typeof option === 'object' ? (option.value ?? option.id ?? '') : option,
    ));
    if (typeof value !== 'string' && typeof value !== 'number') return false;
    return options.includes(String(value))
      || (['select', 'dropdown'].includes(target.type) && target.allow_other === true && typeof value === 'string');
  }
  return true;
}

// Reference-only recovery of an unchanged historical snapshot. The persisted
// raw answer must independently agree with the persisted applicant linkage.
// Explicit review edits/clears, existing records and ambiguous fields never
// qualify. No organisation writes or server-created exemptions are granted.
async function recoverOrganization({ db, tenantId, submission, source, target, value, sourceFields, targetFields }) {
  const identity = field => field.type === 'organisation_dropdown'
    && field.locked === true && field.prefill_field === 'org:name';
  if (!identity(source) || !identity(target)
      || sourceFields.filter(identity).length !== 1 || targetFields.filter(identity).length !== 1) return value;
  const linked = submission.form_submission?.organization_id;
  const original = layerAnswer(submission.original_form_values, source);
  const reviewed = layerAnswer(submission.reviewed_form_values, source);
  const raw = layerAnswer(submission.form_submission?.submission_data, source);
  if (!uuid(linked) || !uuid(value) || linked === value || !original.present
      || original.value !== value || (reviewed.present && reviewed.value !== original.value)
      || raw.value !== linked || submission.form_submission?.tenant_id !== tenantId) return value;
  // Check existence only: an existing foreign record is not a legacy missing
  // reference and must never be repaired into a different tenant's applicant.
  const existing = await db.from('organization').select('id').eq('id', value).maybeSingle();
  if (existing.error) throw existing.error;
  if (existing.data) return value;
  return linked; // Shared validator still verifies tenant and all target filters.
}

export async function prepareSwapAnswers({ db, tenantId, sourceDDSubmission, sourceForm, targetForm }) {
  const sourceFields = sourceForm.fields || [];
  const targetFields = targetForm.fields || [];
  const values = {};
  const mapped = [];
  const newEmpty = [];
  const problems = [];
  const used = new Set();
  const customTypes = new Map();
  async function typed(field) {
    if (field.type !== 'custom_field') return field;
    if (!customTypes.has(field.custom_field_id)) {
      const result = await db.from('preference_field').select('field_type')
        .eq('tenant_id', tenantId).eq('id', field.custom_field_id).maybeSingle();
      if (result.error) throw result.error;
      customTypes.set(field.custom_field_id, result.data?.field_type || 'unresolved_custom_field');
    }
    return { ...field, type: customTypes.get(field.custom_field_id) };
  }
  for (const target of targetFields) {
    const matches = sourceFields.filter(source => label(target) && label(source) === label(target));
    if (!matches.length) {
      newEmpty.push({ fieldId: target.id, fieldLabel: target.label, fieldType: target.type, required: !!target.required });
      continue;
    }
    const source = matches[0];
    const answer = swapSourceAnswer(sourceDDSubmission, source);
    let value = answer.value;
    if (matches.length > 1) {
      problems.push({ fieldId: target.id, fieldLabel: target.label, code: 'AMBIGUOUS_MAPPING', message: 'More than one source field has this label. Review the source form before swapping.' });
    } else if (answer.present) {
      value = await recoverOrganization({ db, tenantId, submission: sourceDDSubmission, source, target, value, sourceFields, targetFields });
      values[target.id] = value;
      const sourceType = await typed(source);
      const targetType = await typed(target);
      if (targetType.type === 'unresolved_custom_field' || sourceType.type === 'unresolved_custom_field'
          || !compatible(sourceType, targetType, value)) {
        problems.push({ fieldId: target.id, fieldLabel: target.label, code: 'INCOMPATIBLE_ANSWER', message: 'The saved answer is not compatible with this target field. Review the answer before swapping.' });
      }
    }
    used.add(source.id);
    mapped.push({
      targetFieldId: target.id, targetFieldLabel: target.label, targetFieldType: target.type,
      sourceFieldId: source.id, sourceFieldLabel: source.label, sourceFieldType: source.type,
      value, hasValue: populated(value), resolvedFromApplicant: value !== answer.value,
    });
  }
  const visibilityOptions = rulesUseLmicOperators(targetForm.visibility_rules)
    ? { lmicCodes: await loadTenantLmicCodes(db, tenantId) } : {};
  const hiddenFieldIds = await computeAuthoritativeHiddenFieldIds({
    db, tenantId, form: targetForm, formValues: values, visibilityOptions,
  });
  const visibleProblems = problems.filter(problem => !hiddenFieldIds.has(problem.fieldId));
  for (const error of validateFutureDateFields(targetFields, values, { hiddenFieldIds })) {
    visibleProblems.push({ ...error, code: 'FUTURE_DATE_INVALID' });
  }
  try {
    await createFormRelationshipService({ db, tenantId }).validateSubmission({
      form: targetForm, submissionData: values, hiddenFieldIds, visibilityOptions,
    });
  } catch (error) {
    if (!(error instanceof FormRelationshipError) || error.status >= 500) throw error;
    const field = targetFields.find(field => field.id === error.fieldId);
    console.warn('[DD Swap] Answer validation rejected', { fieldId: field?.id, reason: error.message });
    visibleProblems.push({
      fieldId: field?.id || null, fieldLabel: field?.label || 'Form selections',
      code: 'INVALID_SELECTION',
      message: 'The saved selection is unavailable or does not meet the target form’s organisation, relationship or conditional rules. Review this field and its parent selections.',
    });
  }
  const ignored = sourceFields.filter(field => !used.has(field.id)).map(field => {
    const { value } = swapSourceAnswer(sourceDDSubmission, field);
    return { fieldId: field.id, fieldLabel: field.label, fieldType: field.type, value, hasValue: populated(value) };
  });
  return { values, fieldMapping: { mapped, newEmpty, ignored }, problems: visibleProblems, canSwap: visibleProblems.length === 0 };
}

export function swapValidationResponse(prepared) {
  return {
    error: 'Some answers cannot be copied to the target form. Review the highlighted fields.',
    code: 'SWAP_ANSWERS_INVALID',
    details: prepared.problems,
  };
}
