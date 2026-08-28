import { loadTenantRelationshipDisplayLabels } from './relationshipDisplayLabels.js';
import {
  isRepeatableRowField,
  repeatableRowChildren,
} from '../../shared/formRepeatableRows.js';

const MAX_IDS = 2000;

function uniqueIds(values) {
  return [...new Set((values || [])
    .filter((value) => value != null && value !== '')
    .map(String))]
    .slice(0, MAX_IDS);
}

function relationshipIdsFromSubmission(fields, submissionData) {
  const ids = new Set();
  const collect = (scopeFields, scopeData) => {
    if (!scopeData || typeof scopeData !== 'object' || Array.isArray(scopeData)) return;
    for (const field of scopeFields || []) {
      const value = field?.id != null
        ? (scopeData[field.id] ?? (field.name ? scopeData[field.name] : undefined))
        : (field?.name ? scopeData[field.name] : undefined);
      if (field?.type === 'relationship_dropdown' && field.id) {
        for (const id of (Array.isArray(value) ? value : [value])) {
          if (id != null && id !== '') ids.add(String(id));
        }
      }
      if (isRepeatableRowField(field) && Array.isArray(value)) {
        const children = repeatableRowChildren(field);
        for (const row of value) collect(children, row);
      }
    }
  };
  collect(fields, submissionData);
  return ids;
}

/**
 * Return the requested IDs that are actually relationship values on the
 * supplied tenant's persisted submissions.  Request IDs are never a source of
 * authority: both the form schema and submission row are loaded server-side.
 */
export async function resolveSubmissionBoundRelationshipRecordIds(
  db,
  tenantId,
  submissionIds,
  requestedRecordIds,
) {
  const ids = uniqueIds(requestedRecordIds);
  const requested = new Set(ids);
  const scopedSubmissionIds = uniqueIds(submissionIds);
  if (!db || !tenantId || ids.length === 0 || scopedSubmissionIds.length === 0) return [];

  const { data: submissions, error: submissionError } = await db
    .from('form_submission')
    .select('id, form_id, submission_data')
    .eq('tenant_id', tenantId)
    .in('id', scopedSubmissionIds);
  if (submissionError) throw submissionError;
  if (!submissions?.length) return [];

  const formIds = uniqueIds(submissions.map((submission) => submission.form_id));
  const { data: forms, error: formError } = await db
    .from('form')
    .select('id, fields')
    .eq('tenant_id', tenantId)
    .in('id', formIds);
  if (formError) throw formError;

  const formsById = new Map((forms || []).map((form) => [String(form.id), form]));
  const allowed = new Set();
  for (const submission of submissions) {
    const form = formsById.get(String(submission.form_id));
    if (!form) continue;
    for (const recordId of relationshipIdsFromSubmission(form.fields, submission.submission_data)) {
      if (requested.has(recordId)) allowed.add(recordId);
    }
  }
  return [...allowed];
}

/**
 * A review permission is permission to review due-diligence applications, not
 * permission to browse every ordinary form submission. Keep that context bound
 * to an existing tenant-scoped due-diligence row.
 */
export async function resolveReviewSubmissionIds(db, tenantId, submissionIds) {
  const ids = uniqueIds(submissionIds);
  if (!db || !tenantId || ids.length === 0) return [];
  const { data, error } = await db
    .from('form_submission_due_diligence')
    .select('form_submission_id')
    .eq('tenant_id', tenantId)
    .in('form_submission_id', ids);
  if (error) throw error;
  return uniqueIds((data || []).map((row) => row.form_submission_id));
}

export async function loadSubmissionScopedRelationshipDisplayLabels(
  db,
  tenantId,
  submissionIds,
  requestedRecordIds,
  loadLabels = loadTenantRelationshipDisplayLabels,
) {
  const allowedRecordIds = await resolveSubmissionBoundRelationshipRecordIds(
    db,
    tenantId,
    submissionIds,
    requestedRecordIds,
  );
  if (allowedRecordIds.length === 0) return {};
  return loadLabels(db, tenantId, allowedRecordIds);
}

export function canAccessRelationshipLabelContext(excludedFeatures, context) {
  const excluded = Array.isArray(excludedFeatures) ? excludedFeatures : [];
  if (context === 'review-submission') return !excluded.includes('page_ReviewSubmission');
  if (context === 'form-submissions') return !excluded.includes('page_FormSubmissions');
  return false;
}