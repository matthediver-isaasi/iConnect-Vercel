import { getCustomObjectFieldMetadata, resolveCustomObjectDisplayValue } from './customObjectDomain.js';
import { isOrganizationEligibleForField } from './organizationEligibility.js';
import { conditionalSelectionAllowed, resolveConditionalFilter } from './formConditionalFilters.js';
import { containsFormNotListedValue, hasEnabledFormNotListedChoice, isFormNotListedValue, validateFormNotListedText } from '../../shared/formNotListedChoice.js';
import { isFormNoRelationshipValue } from '../../shared/formNoRelationshipChoice.js';
import { isRepeatableRowField, repeatableRowChildren } from '../../shared/formRepeatableRows.js';
import { computeHiddenFieldIds } from './formFieldVisibility.js';

export class FormRelationshipError extends Error { constructor(status, message) { super(message); this.status = status; } }
function throwDb(error) { if (error) throw new FormRelationshipError(500, error.message || 'Database operation failed'); }
const KINDS = new Set(['organization', 'organization_group', 'custom_object']);
const TABLES = { organization: 'organization', organization_group: 'organization_group', custom_object: 'custom_object_record' };
export function pagination(query = {}) {
  const page = Math.max(Number.parseInt(query.page, 10) || 1, 1);
  const pageSize = Math.min(Math.max(Number.parseInt(query.pageSize, 10) || 25, 1), 100);
  return { page, pageSize };
}
export function organizationRelationshipSide(definition) {
  const source = definition?.source_kind === 'organization' && definition.source_custom_object_id == null
    && definition.target_kind === 'custom_object' && Boolean(definition.target_custom_object_id);
  const target = definition?.target_kind === 'organization' && definition.target_custom_object_id == null
    && definition.source_kind === 'custom_object' && Boolean(definition.source_custom_object_id);
  if (source === target) return null;
  return { organizationSide: source ? 'source' : 'target', relatedSide: source ? 'target' : 'source',
    customObjectId: source ? definition.target_custom_object_id : definition.source_custom_object_id };
}
function endpoint(definition, side) {
  const kind = definition?.[`${side}_kind`];
  const customObjectId = definition?.[`${side}_custom_object_id`] || null;
  return KINDS.has(kind) && (kind !== 'custom_object' || customObjectId)
    ? { side, kind, custom_object_id: kind === 'custom_object' ? customObjectId : null } : null;
}
function fieldValue(data, field) {
  if (data?.[field?.id] !== undefined) return data[field.id];
  return field?.name ? data?.[field.name] : undefined;
}
function fieldScope(field, inContainer) {
  const scope = field?.parent_field_scope ?? (inContainer ? 'row' : 'form');
  if (scope !== 'row' && scope !== 'form') throw new FormRelationshipError(409, 'Saved relationship field parent scope is invalid');
  return scope;
}
export function savedRelationshipField(form, fieldId, context = {}) {
  const root = context.rootForm || form;
  const container = context.containerFieldId == null ? null : (root.fields || []).find(f => String(f?.id) === String(context.containerFieldId));
  const children = container ? repeatableRowChildren(container) : (form?.fields || []);
  const index = children.findIndex(f => String(f?.id) === String(fieldId));
  if (index < 0) throw new FormRelationshipError(404, 'Relationship field not found');
  const field = children[index];
  if (field?.type !== 'relationship_dropdown') throw new FormRelationshipError(409, 'Saved field is not a relationship dropdown');
  const scope = fieldScope(field, Boolean(container));
  const parentFields = scope === 'form' && container ? (root.fields || []) : children;
  const limit = scope === 'form' && container ? (root.fields || []).findIndex(f => String(f?.id) === String(container.id)) : index;
  const parent = parentFields.find((candidate, parentIndex) => String(candidate?.id) === String(field.parent_field_id) && parentIndex < limit);
  if (!parent) throw new FormRelationshipError(409, 'Saved relationship field parent is invalid');
  const relationshipDefinitionId = field.relationship_definition_id;
  const parentKind = field.relationship_parent_kind || (parent.type === 'organisation_dropdown' ? 'organization' : null);
  const relatedKind = field.related_kind || 'custom_object';
  const parentCustomObjectId = field.relationship_parent_custom_object_id || null;
  const relatedCustomObjectId = field.related_custom_object_id || field.custom_object_id || null;
  const primaryDisplayFieldId = field.related_primary_display_field_id || field.custom_object_primary_display_field_id || null;
  if (!relationshipDefinitionId || !parentKind || !relatedKind || !KINDS.has(parentKind) || !KINDS.has(relatedKind)
      || (parentKind === 'custom_object' && !parentCustomObjectId) || (relatedKind === 'custom_object' && (!relatedCustomObjectId || !primaryDisplayFieldId))) {
    throw new FormRelationshipError(409, 'Saved relationship field configuration is incomplete');
  }
  const expectedParentType = { organization: 'organisation_dropdown', organization_group: 'organisation_group_dropdown', custom_object: 'relationship_dropdown' }[parentKind];
  if (parent.type !== 'relationship_dropdown' && parent.type !== expectedParentType) {
    throw new FormRelationshipError(409, 'Saved relationship field parent is invalid');
  }
  // A relationship dropdown parent represents its own *related* endpoint.
  // Do not allow a child to redefine that endpoint through browser supplied
  // metadata: chains must agree with the persisted parent descriptor.
  if (parent.type === 'relationship_dropdown') {
    const parentRelatedKind = parent.related_kind || 'custom_object';
    const parentRelatedObjectId = parent.related_custom_object_id || parent.custom_object_id || null;
    if (parentRelatedKind !== parentKind
        || String(parentKind === 'custom_object' ? parentRelatedObjectId : null) !== String(parentCustomObjectId)) {
      throw new FormRelationshipError(409, 'Saved relationship field parent is invalid');
    }
  }
  return { field, parentField: parent, parentScope: scope, relationshipDefinitionId, parent: { kind: parentKind, custom_object_id: parentCustomObjectId, side: field.relationship_parent_side || null },
    related: { kind: relatedKind, custom_object_id: relatedCustomObjectId, primary_display_field_id: primaryDisplayFieldId },
    customObjectId: relatedCustomObjectId, primaryDisplayFieldId };
}
function descriptor(definition, side) {
  const e = endpoint(definition, side);
  return e && { ...e, label: definition[`${side}_label`] || null };
}
function publicDefinition(definition, parentSide, objects) {
  const parent = descriptor(definition, parentSide); const related = descriptor(definition, parentSide === 'source' ? 'target' : 'source');
  const relatedObject = related?.kind === 'custom_object' ? objects.get(related.custom_object_id) : null;
  const parentObject = parent?.kind === 'custom_object' ? objects.get(parent.custom_object_id) : null;
  if ((related?.kind === 'custom_object' && !relatedObject) || (parent?.kind === 'custom_object' && !parentObject)) return null;
  return { id: definition.id, relationship_definition_id: definition.id,
  discovery_key: `${definition.id}:${parentSide}`, selection_key: `${definition.id}:${parentSide}`,
  relationship_key: definition.relationship_key,
  relationship_parent_side: parentSide, relationship_parent_kind: parent.kind,
  relationship_parent_custom_object_id: parent.custom_object_id,
  related_kind: related.kind, related_custom_object_id: related.custom_object_id,
  related_primary_display_field_id: relatedObject?.primary_display_field_id || null,
  parent, related: { ...related,
    ...(relatedObject ? { custom_object: { id: relatedObject.id, object_key: relatedObject.object_key, singular_label: relatedObject.singular_label, plural_label: relatedObject.plural_label, primary_display_field_id: relatedObject.primary_display_field_id } } : {}) },
  // legacy consumers only understand organization -> custom object.
  ...(parent.kind === 'organization' && related.kind === 'custom_object' ? { organization_side: parentSide, label: definition[`${parentSide === 'source' ? 'target' : 'source'}_label`], custom_object: { id: relatedObject.id, object_key: relatedObject.object_key, singular_label: relatedObject.singular_label, plural_label: relatedObject.plural_label, primary_display_field_id: relatedObject.primary_display_field_id } } : {}) };
}
export function createFormRelationshipService({ db, tenantId }) {
  if (!db) throw new FormRelationshipError(503, 'Database unavailable');
  if (!tenantId) throw new FormRelationshipError(400, 'Tenant context not found');
  async function readAll(build, chunkSize = 500) { const all = []; for (let n = 0;; n += chunkSize) { const { data, error } = await build().range(n, n + chunkSize - 1); throwDb(error); all.push(...(data || [])); if (!data || data.length < chunkSize) return all; } }
  async function loadForm({ formId, slug, activeOnly = false }) { let q = db.from('form').select('*').eq('tenant_id', tenantId); q = formId ? q.eq('id', formId) : slug ? q.eq('slug', slug) : null; if (!q) throw new FormRelationshipError(400, 'Form is required'); if (activeOnly) q = q.eq('is_active', true); const { data, error } = await q.maybeSingle(); throwDb(error); if (!data) throw new FormRelationshipError(404, 'Form not found'); return data; }
  async function activeObject(id) { const { data, error } = await db.from('custom_object_definition').select('*').eq('tenant_id', tenantId).eq('id', id).eq('status', 'active').maybeSingle(); throwDb(error); return data; }
  async function eligibleDefinitions(formId) {
    await loadForm({ formId }); const { data, error } = await db.from('custom_object_relationship_definition').select('*').eq('tenant_id', tenantId).eq('status', 'active').order('relationship_key', { ascending: true }).order('id', { ascending: true }); throwDb(error);
    const sides = (data || []).flatMap(d => ['source', 'target'].map(side => ({ d, side, parent: endpoint(d, side), related: endpoint(d, side === 'source' ? 'target' : 'source') }))).filter(x => x.parent && x.related && x.d[`show_on_${x.side}`] !== false);
    const ids = [...new Set(sides.flatMap(x => [x.parent, x.related]).filter(x => x.kind === 'custom_object').map(x => x.custom_object_id))];
    const objects = new Map(); if (ids.length) { const { data: rows, error: e } = await db.from('custom_object_definition').select('id, object_key, singular_label, plural_label, primary_display_field_id, status').eq('tenant_id', tenantId).eq('status', 'active').in('id', ids); throwDb(e); (rows || []).forEach(x => objects.set(x.id, x)); }
    return { data: sides.map(x => publicDefinition(x.d, x.side, objects)).filter(Boolean).filter(x => x.parent.kind !== 'member') };
  }
  async function loadEndpoint(kind, id, objectId) {
    let q = db.from(TABLES[kind]).select('*').eq('tenant_id', tenantId).eq('id', id);
    if (kind === 'custom_object') q = q.eq('custom_object_id', objectId).is('archived_at', null);
    const { data, error } = await q.maybeSingle(); throwDb(error); return data;
  }
  async function verified({ form, fieldId, parentRecordId, rootForm, containerFieldId }) {
    const saved = savedRelationshipField(form, fieldId, { rootForm, containerFieldId });
    const parentRow = await loadEndpoint(saved.parent.kind, parentRecordId, saved.parent.custom_object_id);
    if (!parentRow) throw new FormRelationshipError(404, 'Relationship parent not found');
    if (saved.parent.kind === 'organization') { try { const ok = await isOrganizationEligibleForField({ db, tenantId, organization: parentRow, field: saved.parentField }); if (!ok) throw new FormRelationshipError(400, 'Organization is not eligible for this field'); } catch (e) { if (e instanceof FormRelationshipError) throw e; throwDb(e); } }
    const { data: definition, error } = await db.from('custom_object_relationship_definition').select('*').eq('tenant_id', tenantId).eq('id', saved.relationshipDefinitionId).eq('status', 'active').maybeSingle(); throwDb(error);
    const ps = saved.parent.side; const matches = ['source', 'target'].filter(side => {
      const p = endpoint(definition, side); const r = endpoint(definition, side === 'source' ? 'target' : 'source');
      return p && r && (!ps || ps === side) && p.kind === saved.parent.kind && String(p.custom_object_id) === String(saved.parent.custom_object_id) && r.kind === saved.related.kind && String(r.custom_object_id) === String(saved.related.custom_object_id) && definition[`show_on_${side}`] !== false;
    });
    if (!definition || matches.length !== 1) throw new FormRelationshipError(409, 'Saved relationship configuration is unavailable');
    const parentSide = matches[0]; let relatedObject = null; let primaryField = null;
    if (saved.related.kind === 'custom_object') { relatedObject = await activeObject(saved.related.custom_object_id); if (!relatedObject || String(relatedObject.primary_display_field_id) !== String(saved.related.primary_display_field_id)) throw new FormRelationshipError(409, 'Related Custom Object is unavailable'); const r = await db.from('preference_field').select('*').eq('tenant_id', tenantId).eq('id', relatedObject.primary_display_field_id).eq('custom_object_id', relatedObject.id).eq('entity_scope', 'custom_object').eq('is_active', true).maybeSingle(); throwDb(r.error); primaryField = r.data; if (!primaryField || !getCustomObjectFieldMetadata(primaryField).key) throw new FormRelationshipError(409, 'Related Custom Object display field is unavailable'); }
    return { saved, parentRow, definition, parentSide, relatedSide: parentSide === 'source' ? 'target' : 'source', relatedObject, primaryField };
  }
  async function relationshipOptions({ formId, slug, form: supplied, fieldId, parentRecordId, organizationId, query = {}, activeOnly = true, rootForm, containerFieldId }) {
    parentRecordId = parentRecordId || organizationId; if (!fieldId || !parentRecordId) throw new FormRelationshipError(400, 'fieldId and parentRecordId are required');
    const form = supplied || await loadForm({ formId, slug, activeOnly }); const state = await verified({ form, fieldId, parentRecordId, rootForm: rootForm || form, containerFieldId });
    const edges = await readAll(() => db.from('custom_object_relationship').select('id, source_record_id, target_record_id').eq('tenant_id', tenantId).eq('relationship_definition_id', state.definition.id).eq(`${state.parentSide}_record_id`, parentRecordId).is('archived_at', null));
    const ids = [...new Set(edges.map(e => e[`${state.relatedSide}_record_id`]).filter(Boolean))]; const rows = []; for (let i = 0; i < ids.length; i += 500) rows.push(...await readAll(() => { let q = db.from(TABLES[state.saved.related.kind]).select('*').eq('tenant_id', tenantId).in('id', ids.slice(i, i + 500)); if (state.saved.related.kind === 'custom_object') q = q.eq('custom_object_id', state.relatedObject.id).is('archived_at', null); return q; }));
    const options = rows.map(row => ({ id: row.id, label: state.saved.related.kind === 'organization' ? row.name || row.id : state.saved.related.kind === 'organization_group' ? row.name || row.id : resolveCustomObjectDisplayValue({ objectDefinition: state.relatedObject, record: row, fields: [state.primaryField] }) })).sort((a, b) => String(a.label).localeCompare(String(b.label)) || String(a.id).localeCompare(String(b.id)));
    const p = pagination(query); return { data: options.slice((p.page - 1) * p.pageSize, p.page * p.pageSize), total: options.length, page: p.page, pageSize: p.pageSize };
  }
  async function validateSubmission({ form, submissionData = {}, cache = new Map(), rootForm, rootSubmissionData, containerFieldId, allowMissingNotListedText, hiddenFieldIds, visibilityOptions = {} }) {
    const authoritativeForm = rootForm || form;
    const hidden = hiddenFieldIds || computeHiddenFieldIds(
      authoritativeForm,
      rootSubmissionData || submissionData,
      visibilityOptions,
    );
    if (containerFieldId && hidden.has(containerFieldId)) return;
    const fields = (form?.fields || []).filter(field => !hidden.has(field?.id));
    const notListedTextValidation = validateFormNotListedText(fields, submissionData, {
      allowMissingText: allowMissingNotListedText,
      ignoredFieldIds: hidden,
    });
    if (!notListedTextValidation.valid) {
      throw new FormRelationshipError(400, notListedTextValidation.error);
    }
    for (const field of fields) { const selected = fieldValue(submissionData, field); if (containsFormNotListedValue(selected) && !hasEnabledFormNotListedChoice(field)) throw new FormRelationshipError(400, 'Invalid not-listed selection'); if (Array.isArray(selected) && containsFormNotListedValue(selected) && selected.length !== 1) throw new FormRelationshipError(400, 'Not-listed selection must be exclusive'); if ((field?.type === 'countries' || field?.type === 'category_multiselect') && isFormNotListedValue(selected)) throw new FormRelationshipError(400, 'Invalid multi-select not-listed selection'); if (!conditionalSelectionAllowed(selected, resolveConditionalFilter(field, submissionData, fields))) throw new FormRelationshipError(400, 'Invalid conditional field selection'); }
    for (const field of fields.filter(x => x?.type === 'organisation_dropdown')) {
      const id = fieldValue(submissionData, field);
      if (id == null || id === '' || isFormNotListedValue(id)) continue;
      if (typeof id !== 'string' && typeof id !== 'number') throw new FormRelationshipError(400, 'Invalid organization selection');
      const key = `organization:${id}`;
      let organization = cache.get(key);
      if (organization === undefined) { const result = await db.from('organization').select('*').eq('tenant_id', tenantId).eq('id', id).maybeSingle(); throwDb(result.error); organization = result.data || null; cache.set(key, organization); }
      if (!organization) throw new FormRelationshipError(400, 'Invalid organization selection');
      const resolution = resolveConditionalFilter(field, submissionData, fields);
      try {
        const eligible = await isOrganizationEligibleForField({ db, tenantId, organization, field });
        const conditional = !resolution.orgFilter || await isOrganizationEligibleForField({ db, tenantId, organization, field: { org_filter: resolution.orgFilter } });
        if (!eligible || !conditional) throw new FormRelationshipError(400, 'Invalid organization selection');
      } catch (error) { if (error instanceof FormRelationshipError) throw error; throwDb(error); }
    }
    for (const field of fields.filter(x => x?.type === 'relationship_dropdown')) {
      const selected = fieldValue(submissionData, field);
      if (selected == null || selected === '' || isFormNotListedValue(selected)) continue;
      const recordIds = [...new Set((Array.isArray(selected) ? selected : [selected]).filter(Boolean))];
      if (recordIds.length === 0 || recordIds.some(recordId =>
        isFormNoRelationshipValue(recordId)
          || (typeof recordId !== 'string' && typeof recordId !== 'number'))) {
        throw new FormRelationshipError(400, 'Invalid relationship selection');
      }
      const saved = savedRelationshipField(form, field.id, {
        rootForm: rootForm || form,
        containerFieldId,
      });
      const parentData = saved.parentScope === 'form' && containerFieldId
        ? (rootSubmissionData || submissionData)
        : submissionData;
      const parentRecordId = fieldValue(parentData, saved.parentField);
      if (!parentRecordId || isFormNotListedValue(parentRecordId)) {
        throw new FormRelationshipError(400, 'Invalid relationship selection');
      }
      const state = await verified({
        form,
        fieldId: field.id,
        parentRecordId,
        rootForm: rootForm || form,
        containerFieldId,
      });
      for (const recordId of recordIds) {
        const key = [
          containerFieldId || 'root',
          field.id,
          state.definition.id,
          state.parentSide,
          saved.parent.kind,
          saved.parent.custom_object_id || '',
          saved.related.kind,
          saved.related.custom_object_id || '',
          parentRecordId,
          recordId,
        ].join(':');
        if (cache.get(key)) continue;
        const { data: edge, error } = await db.from('custom_object_relationship')
          .select('id')
          .eq('tenant_id', tenantId)
          .eq('relationship_definition_id', state.definition.id)
          .eq(`${state.parentSide}_record_id`, parentRecordId)
          .eq(`${state.relatedSide}_record_id`, recordId)
          .is('archived_at', null)
          .maybeSingle();
        throwDb(error);
        const record = await loadEndpoint(
          saved.related.kind,
          recordId,
          saved.related.custom_object_id,
        );
        if (!edge || !record) {
          throw new FormRelationshipError(400, 'Invalid relationship selection');
        }
        cache.set(key, true);
      }
    }
  }
  return { loadForm, eligibleDefinitions, relationshipOptions, validateSubmission };
}