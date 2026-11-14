import { getTenantSlugFromLocation } from '@/api/publicClient';
import { getSavedFormFieldValue } from '@/lib/formRelationshipDropdown';
import { isFieldValueFilled } from '@/lib/formFieldPrefill';
import { isRepeatableRowField, normalizeRepeatableRowField, repeatableRowChildren, validateRepeatableRowConfiguration, validateRepeatableRows } from '../../../../shared/formRepeatableRows.js';
import { isRelationshipMultiSelect } from '../../../../shared/formRelationshipSelection.js';

export const editableEvidenceTypes = new Set(['text', 'textarea', 'email', 'number', 'tel', 'date', 'time', 'country', 'percentage', 'currency', 'boolean', 'dropdown', 'select', 'radio', 'url', 'checkbox', 'countries', 'list', 'file', 'address_lookup', 'signature', 'grouped_question', 'repeatable_rows', 'repeatable_row', 'repeatable_grid']);
export const directoryEvidenceTypes = new Set(['relationship_dropdown', 'organisation_dropdown', 'organisation_group_dropdown']);
export const cloneEvidence = value => JSON.parse(JSON.stringify(value));
export const sameEvidence = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const safeId = id => typeof id === 'string' && id.trim() && !['__proto__', 'prototype', 'constructor'].includes(id);
const safeMetadata = field => !field.read_only && !field.display_only && !field.option_source
  && !/password|client[_ ]?secret|access[_ ]?token|session[_ ]?token/i.test(`${field.name || ''} ${field.label || ''}`)
  && !['create_entity', 'entity_action', 'entity_actions', 'on_change_action', 'payment_config', 'commerce', 'mutation', 'group_initial_selection'].some(key => field[key]);

export function editableEvidenceField(field, value, rootFields = [], { existingChoiceAccess = false } = {}) {
  const directory = directoryEvidenceTypes.has(field?.type);
  if (!field || !safeId(field.id) || (!editableEvidenceTypes.has(field.type) && !(directory && existingChoiceAccess === true))
    || !safeMetadata(directory ? { ...field, group_initial_selection: undefined } : field)
    || field.repeatable_container_field_id || (field.type === 'email' && field.validate_org_domain)
    || (field.type === 'file' && Array.isArray(value))) return false;
  if (directory) {
    // Root, canonical existing-record choices only. Nested/row-source choices,
    // saved Other selections and object-shaped legacy values stay read-only.
    if (!rootFields.some(root => root.id === field.id) || field.option_source !== undefined) return false;
    const values = Array.isArray(value) ? value : [value];
    if (values.some(item => item != null && (typeof item !== 'string' || item === '__form_not_listed__'))) return false;
    if (field.type !== 'relationship_dropdown' && Array.isArray(value)) return false;
    if (Array.isArray(value) && (!isRelationshipMultiSelect(field) || value.some(item => typeof item !== 'string' || !item) || new Set(value).size !== value.length)) return false;
    if (field.type === 'relationship_dropdown' && (!field.relationship_definition_id || !rootFields.some(root => root.id === field.parent_field_id))) return false;
    return true;
  }
  if (field.type === 'list' && value != null && (!Array.isArray(value) || value.some(item => typeof item !== 'string'))) return false;
  if (field.type === 'grouped_question') {
    const questions = field.sub_questions;
    return Array.isArray(questions) && questions.length > 0
      && new Set(questions.map(question => question?.id)).size === questions.length
      && questions.every(question => question && safeId(question.id) && safeMetadata(question)
        && (!question.type || ['text', 'textarea'].includes(question.type)))
      && (value == null || (typeof value === 'object' && !Array.isArray(value)
        && Object.values(value).every(answer => answer == null || typeof answer === 'string')));
  }
  if (isRepeatableRowField(field)) {
    const raw = repeatableRowChildren(field), config = normalizeRepeatableRowField(field);
    const source = field.repeatable_row && typeof field.repeatable_row === 'object' ? field.repeatable_row : field;
    const configuredChildren = source.children ?? source.child_fields ?? source.fields;
    // Use the canonical metadata/parser and reject every unsupported child,
    // rather than rendering an unsafe widget merely disabled inside a row.
    if (!Array.isArray(configuredChildren) || configuredChildren.length !== raw.length
      || !validateRepeatableRowConfiguration(field, { rootFields }).valid || !raw.length || raw.length !== config.children.length) return false;
    if (value != null && !Array.isArray(value)) return false;
    const children = new Set(config.children.map(child => child.id));
    const rows = value || [];
    if (rows.some(row => !row || typeof row !== 'object' || Array.isArray(row)
      || Object.keys(row).some(key => !children.has(key) && !['_row_id', '__not_listed_choice_text'].includes(key)))) return false;
    const rowIds = new Set(), hasFiles = config.children.some(child => child.type === 'file');
    for (const row of rows) {
      if (row._row_id === undefined && !hasFiles) continue;
      if (typeof row._row_id !== 'string' || !row._row_id.trim() || row._row_id.length > 200 || rowIds.has(row._row_id)) return false;
      rowIds.add(row._row_id);
    }
    return config.children.every(child => !isRepeatableRowField(child)
      && !['address_lookup', 'signature', 'grouped_question'].includes(child.type)
      && !(child.type === 'file' && child.default_value)
      && editableEvidenceField(child, undefined, rootFields)
      && rows.every(row => editableEvidenceField(child, row[child.id], rootFields)));
  }
  if (field.type === 'signature' && value) return typeof (value.data || value) === 'string'
    && /^data:image\/png;base64,[A-Za-z0-9+/=\r\n]+$/.test(value.data || value);
  return true;
}

export function amendmentFileCells(field, value) {
  if (field.type === 'file') return [{ key: JSON.stringify([field.id]), rootId: field.id, label: field.label || field.id, value, path: [] }];
  if (!isRepeatableRowField(field) || !Array.isArray(value)) return [];
  return value.flatMap((row, index) => normalizeRepeatableRowField(field).children.filter(child => child.type === 'file').map(child => ({
    key: JSON.stringify([field.id, row._row_id || `index:${index}`, child.id]), rootId: field.id,
    rowId: row._row_id, index, childId: child.id, path: [index, child.id],
    label: `${field.label || field.id} · row ${index + 1} · ${child.label || child.id}`, value: row[child.id],
  })));
}

export function authorisedAmendmentUpload(fields, answers, savedAnswers, fieldId) {
  const matches = [];
  for (const field of fields) {
    if (!editableEvidenceField(field, getSavedFormFieldValue(savedAnswers, field), fields)) continue;
    for (const cell of amendmentFileCells(field, getSavedFormFieldValue(answers, field))) {
      const renderedId = cell.childId ? `${cell.childId}-${cell.rowId}` : field.id;
      if (renderedId === fieldId && (!cell.childId || (typeof cell.rowId === 'string' && cell.rowId))) matches.push(cell);
    }
  }
  return matches.length === 1 ? matches[0] : null;
}

// A new request must not carry replacements uploaded under the old request.
// Preserve edited children verbatim, fail closed on concurrent root changes,
// and reset only replacement FILE cells for explicit reattachment.
export function rebaseAmendmentEvidence(fields, baseline, edited, saved, access = {}) {
  const next = cloneEvidence(saved), reattach = [];
  for (const field of fields) {
    const base = getSavedFormFieldValue(baseline, field), local = getSavedFormFieldValue(edited, field), current = getSavedFormFieldValue(saved, field);
    if (!editableEvidenceField(field, base, fields, access) || sameEvidence(local, base)) continue;
    if (!sameEvidence(current, base) && !sameEvidence(current, local)) throw new Error(`Saved evidence for “${field.label || field.id}” changed concurrently. No edited children were overwritten or rebased. Your local worksheet/reason and frozen request remain here; explicitly compare/reconcile from application status before replacing this worksheet.`);
    if (local === undefined) continue;
    const desired = cloneEvidence(local), currentFiles = amendmentFileCells(field, current);
    let root = desired;
    for (const cell of amendmentFileCells(field, desired)) {
      const retained = currentFiles.find(other => other.key === cell.key);
      if (cell.value && !sameEvidence(cell.value, retained?.value)) {
        const restored = retained?.value == null ? null : cloneEvidence(retained.value);
        reattach.push({ ...cell, value: undefined, restored });
        if (cell.path.length) root[cell.index][cell.childId] = restored;
        else root = restored;
      }
    }
    next[field.id] = root;
  }
  return { answers: next, reattach };
}

export function amendmentValidationErrors(fields, answers, baseline = answers, access = {}) {
  return fields.flatMap(field => {
    const value = getSavedFormFieldValue(answers, field);
    if (!editableEvidenceField(field, getSavedFormFieldValue(baseline, field), fields, access)) return [];
    if (!editableEvidenceField(field, value, fields, access)) return [`${field.label || field.id}: this edited value does not match the supported canonical evidence shape. Saved evidence has not been overwritten.`];
    if (isRepeatableRowField(field)) return validateRepeatableRows(field, value, { rootFields: fields }).errors.map(error => `${field.label || field.id}: ${error.message}`);
    const groupedStarted = field.type === 'grouped_question' && Object.values(value || {}).some(answer => typeof answer === 'string' && answer.trim());
    if ((field.required || groupedStarted) && !isFieldValueFilled(field, value)) return [`${field.label || field.id}: complete the required answer or configured grouped-question minimum/maximum.`];
    if (field.type === 'signature' && value && (typeof (value.data || value) !== 'string' || !/^data:image\/png;base64,[A-Za-z0-9+/=\r\n]+$/.test(value.data || value))) return [`${field.label || field.id}: use the local signature control to record a PNG signature.`];
    return [];
  });
}

export function assertAmendmentScope(session, tenantSlug) {
  session.assertCurrent();
  if (getTenantSlugFromLocation() !== tenantSlug) throw new Error('Your organisation changed. Reload your member application before continuing.');
}

export async function uploadAmendmentFile({ session, tenantSlug, tenantId, formId, requestId, file, signal }) {
  assertAmendmentScope(session, tenantSlug);
  if (typeof tenantId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(tenantId)) {
    throw new Error('The amendment editor did not supply a validated tenant. Reload your application authority before uploading.');
  }
  if (!file.size || file.size > 25 * 1024 * 1024) throw new Error('Evidence files must be nonempty and no larger than 25 MB.');
  const params = tenantSlug ? `?tenant=${encodeURIComponent(tenantSlug)}` : '';
  const response = await fetch(`/api/storage/signed-upload-url${params}`, {
    method: 'POST', credentials: session.externalApplicant ? 'omit' : 'include', signal,
    ...(session.externalApplicant ? { cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer' } : {}),
    headers: { 'Content-Type': 'application/json', 'X-Tenant-Id': tenantId },
    body: JSON.stringify({ fileName: file.name, fileSize: file.size, mimeType: file.type || 'application/octet-stream',
      type: 'form-submission', entityId: requestId, isPrivate: true, formId }),
  });
  assertAmendmentScope(session, tenantSlug);
  const result = await response.json();
  if (!response.ok) throw new Error(typeof result.error === 'string' ? result.error : 'A private evidence upload could not be authorised.');
  const prefix = `${tenantId}/form-submissions/${requestId}/`;
  if (result.bucket !== 'private-uploads' || typeof result.path !== 'string' || !result.path.startsWith(prefix)
    || result.path.split('/').length !== 4 || !result.path.slice(prefix.length) || result.path.includes('..')
    || /[%\\\0\r\n?#]/.test(result.path) || typeof result.signedUrl !== 'string') throw new Error('The upload did not belong to this exact private amendment request.');
  const url = new URL(result.signedUrl, window.location.origin);
  if (url.protocol !== 'https:' && url.origin !== window.location.origin) throw new Error('An unsafe evidence upload destination was refused.');
  assertAmendmentScope(session, tenantSlug);
  const uploaded = await fetch(url.toString(), {
    method: 'PUT', signal, credentials: 'omit',
    headers: { 'Content-Type': file.type || 'application/octet-stream', 'x-upsert': 'true' }, body: file,
  });
  assertAmendmentScope(session, tenantSlug);
  if (!uploaded.ok) throw new Error('The evidence bytes could not be uploaded. No amendment was submitted.');
  return { file_url: `/api/storage/secure-url?bucket=private-uploads&path=${encodeURIComponent(result.path)}&redirect=true`,
    storage_path: result.path, bucket: result.bucket, file_name: file.name, file_size: file.size,
    mime_type: file.type || 'application/octet-stream', is_private: true, uploaded_at: new Date().toISOString() };
}
