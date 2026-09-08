import {
  coalesceExplicitFallbackMappings,
  extractMappingSourceComponent,
} from './formMappingFallbacks.js';
import {
  CRM_NOTE_TARGET_FIELD,
  CRM_NOTE_TARGET_TYPE,
  isCrmNoteSourceField,
  isCrmNotePipelineEntity,
} from '../../shared/formCrmNotes.js';

export {
  CRM_NOTE_TARGET_FIELD,
  CRM_NOTE_TARGET_TYPE,
} from '../../shared/formCrmNotes.js';

const textValue = (value) => {
  if (value === undefined || value === null || value === '__clear__') return '';
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return value.map(item => String(item).trim()).filter(Boolean).join(', ');
  if (typeof value === 'object') return '';
  return String(value).trim();
};

export function collectPipelineCrmNoteIntents(pipeline, values, {
  applyTransformation = value => value,
  hiddenFieldIds = new Set(),
  formFields = [],
  entity = null,
} = {}) {
  if (entity !== null && !isCrmNotePipelineEntity(entity)) {
    throw new Error('CRM notes support member and organization pipelines only');
  }
  const intents = [];
  const fieldsById = new Map((formFields || []).map(field => [String(field.id), field]));
  const mappings = coalesceExplicitFallbackMappings(pipeline?.mappings || [], values, hiddenFieldIds);
  for (const mapping of mappings) {
    if (mapping?.target_type !== CRM_NOTE_TARGET_TYPE || mapping?.target_field !== CRM_NOTE_TARGET_FIELD) continue;
    if (entity && mapping?.target_entity !== entity) continue;
    if ((mapping.source_type || 'field') !== 'field') continue;
    if (!mapping.id || !mapping.source_field_id || hiddenFieldIds.has(String(mapping.source_field_id))) continue;
    const sourceField = fieldsById.get(String(mapping.source_field_id));
    if (!isCrmNoteSourceField(sourceField)) continue;
    if (!Object.prototype.hasOwnProperty.call(values || {}, mapping.source_field_id)) continue;
    let value = extractMappingSourceComponent(mapping, values[mapping.source_field_id]);
    if (mapping.source_category_id && value && typeof value === 'object' && !Array.isArray(value)) {
      value = value[mapping.source_category_id];
    }
    if (mapping.transformation && mapping.transformation !== 'none') {
      value = applyTransformation(value, mapping.transformation);
    }
    const content = textValue(value);
    if (content) {
      const pipelineId = String(pipeline?.id || 'pipeline');
      intents.push({ mappingId: `${pipelineId}:${String(mapping.id)}`, content });
    }
  }
  return intents;
}

async function tenantOwned(db, table, id, tenantId) {
  if (!id || !tenantId) return false;
  const { data, error } = await db.from(table).select('id, tenant_id')
    .eq('id', id).eq('tenant_id', tenantId).maybeSingle();
  if (error) throw error;
  return !!data;
}

export async function persistPipelineCrmNotes({
  db,
  tenantId,
  submissionId,
  entity,
  entityId,
  authorMemberId,
  pipeline,
  values,
  applyTransformation,
  hiddenFieldIds,
  formFields,
}) {
  const intents = collectPipelineCrmNoteIntents(pipeline, values, {
    applyTransformation,
    hiddenFieldIds,
    formFields,
    entity,
  });
  if (!intents.length || !entityId) return { inserted: 0, skipped: intents.length };
  if (!await tenantOwned(db, entity === 'member' ? 'member' : 'organization', entityId, tenantId)) {
    const error = new Error('CRM note target does not belong to the form tenant');
    error.code = 'CRM_NOTE_CROSS_TENANT_TARGET';
    throw error;
  }
  if (authorMemberId && !await tenantOwned(db, 'member', authorMemberId, tenantId)) {
    const error = new Error('CRM note author does not belong to the form tenant');
    error.code = 'CRM_NOTE_INVALID_AUTHOR';
    throw error;
  }

  const table = entity === 'member' ? 'member_note' : 'organization_note';
  let inserted = 0;
  for (const intent of intents) {
    const { data: existing, error: lookupError } = await db.from(table).select('id')
      .eq('form_submission_id', submissionId)
      .eq('form_mapping_id', intent.mappingId)
      .maybeSingle();
    if (lookupError) throw lookupError;
    if (existing) continue;
    const payload = entity === 'member'
      ? {
          target_member_id: entityId,
          author_member_id: authorMemberId || null,
          content: intent.content,
          attachments: [],
          form_submission_id: submissionId,
          form_mapping_id: intent.mappingId,
        }
      : {
          organization_id: entityId,
          member_id: authorMemberId || null,
          content: intent.content,
          attachments: [],
          form_submission_id: submissionId,
          form_mapping_id: intent.mappingId,
        };
    const { error: insertError } = await db.from(table).insert(payload);
    if (insertError && insertError.code !== '23505') throw insertError;
    if (!insertError) inserted += 1;
  }
  return { inserted, skipped: intents.length - inserted };
}