import { getCustomObjectFieldMetadata, resolveCustomObjectDisplayValue } from './customObjectDomain.js';
import { isOrganizationEligibleForField } from './organizationEligibility.js';
import { conditionalSelectionAllowed, resolveConditionalFilter } from './formConditionalFilters.js';
import { containsFormNotListedValue, hasEnabledFormNotListedChoice, isFormNotListedValue, validateFormNotListedText } from '../../shared/formNotListedChoice.js';
import { isFormNoRelationshipValue } from '../../shared/formNoRelationshipChoice.js';
import { isRepeatableRowField, isRepeatableValueEmpty, repeatableRowChildren } from '../../shared/formRepeatableRows.js';
import { computeHiddenFieldIds } from './formFieldVisibility.js';
import {
  isRelationshipMultiSelect,
  relationshipSelectionMode,
  RELATIONSHIP_SELECTION_MULTIPLE,
  RELATIONSHIP_SELECTION_SINGLE,
} from '../../shared/formRelationshipSelection.js';
import {
  isCustomObjectRowSource,
  isDistinctRowSource,
  rowSourceDependencyIds,
  rowSourceValueDomain,
  validateRowSourceConfiguration,
} from '../../shared/formCustomObjectRowSources.js';

export class FormRelationshipError extends Error { constructor(status, message) { super(message); this.status = status; } }
function throwDb(error) { if (error) throw new FormRelationshipError(500, error.message || 'Database operation failed'); }
const KINDS = new Set(['organization', 'organization_group', 'custom_object']);
const TABLES = { organization: 'organization', organization_group: 'organization_group', custom_object: 'custom_object_record' };
const ROW_SOURCE_SCALAR_FIELD_TYPES = new Set([
  'text', 'textarea', 'email', 'url', 'tel', 'phone', 'date', 'time', 'boolean', 'bool',
  'number', 'decimal', 'currency', 'percentage', 'integer', 'select', 'radio', 'dropdown', 'country',
]);
const customObjectRowSourceDomain = metadata => (
  ROW_SOURCE_SCALAR_FIELD_TYPES.has(metadata?.type) ? rowSourceValueDomain(metadata.type) : null
);
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
  if (field.option_source !== undefined && !isCustomObjectRowSource(field)) {
    throw new FormRelationshipError(409, 'Saved Custom Object row source configuration is invalid');
  }
  const scope = fieldScope(field, Boolean(container));
  const parentFields = scope === 'form' && container ? (root.fields || []) : children;
  const limit = scope === 'form' && container ? (root.fields || []).findIndex(f => String(f?.id) === String(container.id)) : index;
  const parent = parentFields.find((candidate, parentIndex) => String(candidate?.id) === String(field.parent_field_id) && parentIndex < limit);
  if (!parent) throw new FormRelationshipError(409, 'Saved relationship field parent is invalid');
  const relationshipDefinitionId = field.relationship_definition_id;
  const parentKind = field.relationship_parent_kind || (parent.type === 'organisation_dropdown' ? 'organization' : null);
  const relatedKind = field.related_kind || 'custom_object';
  const parentCustomObjectId = field.relationship_parent_custom_object_id || null;
  const relatedCustomObjectId = field.option_source?.custom_object_id
    || field.related_custom_object_id || field.custom_object_id || null;
  const primaryDisplayFieldId = field.option_source?.primary_display_field_id
    || field.related_primary_display_field_id || field.custom_object_primary_display_field_id || null;
  if (!relationshipDefinitionId || !parentKind || !relatedKind || !KINDS.has(parentKind) || !KINDS.has(relatedKind)
      || (parentKind === 'custom_object' && !parentCustomObjectId) || (relatedKind === 'custom_object' && (!relatedCustomObjectId || !primaryDisplayFieldId))) {
    throw new FormRelationshipError(409, 'Saved relationship field configuration is incomplete');
  }
  const expectedParentType = { organization: 'organisation_dropdown', organization_group: 'organisation_group_dropdown', custom_object: 'relationship_dropdown' }[parentKind];
  if (parent.type !== 'relationship_dropdown' && parent.type !== expectedParentType) {
    throw new FormRelationshipError(409, 'Saved relationship field parent is invalid');
  }
  if (parent.type === 'relationship_dropdown' && isRelationshipMultiSelect(parent)) {
    throw new FormRelationshipError(409, 'Saved relationship field parent must be single-select');
  }
  // A relationship dropdown parent represents its own *related* endpoint.
  // Do not allow a child to redefine that endpoint through browser supplied
  // metadata: chains must agree with the persisted parent descriptor.
  if (parent.type === 'relationship_dropdown') {
    const parentRelatedKind = parent.related_kind || 'custom_object';
    const parentRelatedObjectId = parent.option_source?.custom_object_id
      || parent.related_custom_object_id || parent.custom_object_id || null;
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
  async function readAll(build, chunkSize = 500, maximum = Number.POSITIVE_INFINITY) {
    const all = [];
    for (let n = 0; all.length < maximum; n += chunkSize) {
      const size = Number.isFinite(maximum)
        ? Math.min(chunkSize, maximum - all.length)
        : chunkSize;
      const { data, error } = await build().range(n, n + size - 1);
      throwDb(error);
      all.push(...(data || []));
      if (!data || data.length < size) return all;
    }
    return all;
  }
  const orderedById = query => (
    typeof query?.order === 'function' ? query.order('id', { ascending: true }) : query
  );
  async function loadForm({ formId, slug, activeOnly = false }) { let q = db.from('form').select('*').eq('tenant_id', tenantId); q = formId ? q.eq('id', formId) : slug ? q.eq('slug', slug) : null; if (!q) throw new FormRelationshipError(400, 'Form is required'); if (activeOnly) q = q.eq('is_active', true); const { data, error } = await q.maybeSingle(); throwDb(error); if (!data) throw new FormRelationshipError(404, 'Form not found'); return data; }
  async function activeObject(id) { const { data, error } = await db.from('custom_object_definition').select('id, object_key, singular_label, plural_label, primary_display_field_id, status, archived_at, configuration').eq('tenant_id', tenantId).eq('id', id).eq('status', 'active').maybeSingle(); throwDb(error); return data && !data.archived_at ? data : null; }
  async function eligibleDefinitions(formId, authorAccess = null) {
    await loadForm({ formId }); const { data, error } = await db.from('custom_object_relationship_definition').select('*').eq('tenant_id', tenantId).eq('status', 'active').order('relationship_key', { ascending: true }).order('id', { ascending: true }); throwDb(error);
    const sides = (data || []).filter(d => !d.archived_at).flatMap(d => ['source', 'target'].map(side => ({ d, side, parent: endpoint(d, side), related: endpoint(d, side === 'source' ? 'target' : 'source') }))).filter(x => x.parent && x.related && x.d[`show_on_${x.side}`] !== false);
    const ids = [...new Set(sides.flatMap(x => [x.parent, x.related]).filter(x => x.kind === 'custom_object').map(x => x.custom_object_id))];
    const objects = new Map(); if (ids.length) { const { data: rows, error: e } = await db.from('custom_object_definition').select('id, object_key, singular_label, plural_label, primary_display_field_id, status').eq('tenant_id', tenantId).eq('status', 'active').in('id', ids); throwDb(e); (rows || []).forEach(x => objects.set(x.id, x)); }
    const relationships = sides.map(x => publicDefinition(x.d, x.side, objects)).filter(Boolean).filter(x => x.parent.kind !== 'member');
    const { data: allObjects, error: objectError } = await db.from('custom_object_definition')
      .select('id, object_key, singular_label, plural_label, primary_display_field_id, status, archived_at')
      .eq('tenant_id', tenantId).eq('status', 'active')
      .order('singular_label', { ascending: true }).order('id', { ascending: true });
    throwDb(objectError);
    const activeObjects = (allObjects || []).filter(object => !object.archived_at);
    const objectIds = activeObjects.map(object => object.id);
    let allFields = [];
    if (objectIds.length) {
      const result = await db.from('preference_field')
        .select('id, custom_object_id, name, label, field_type, is_active')
        .eq('tenant_id', tenantId).eq('entity_scope', 'custom_object')
        .eq('is_active', true).in('custom_object_id', objectIds)
        .order('display_order', { ascending: true }).order('id', { ascending: true });
      throwDb(result.error);
      allFields = result.data || [];
    }
    let customObjects = activeObjects.map(object => {
      const fields = allFields.filter(field => String(field.custom_object_id) === String(object.id)
        && getCustomObjectFieldMetadata(field).active
        && ROW_SOURCE_SCALAR_FIELD_TYPES.has(getCustomObjectFieldMetadata(field).type)
        && getCustomObjectFieldMetadata(field).key);
      if (!fields.some(field => String(field.id) === String(object.primary_display_field_id))) return null;
      return {
        id: object.id,
        object_key: object.object_key,
        singular_label: object.singular_label,
        plural_label: object.plural_label,
        primary_display_field_id: object.primary_display_field_id,
        fields: fields.map(field => ({
          id: field.id,
          name: getCustomObjectFieldMetadata(field).key,
          label: field.label || field.name,
          field_type: getCustomObjectFieldMetadata(field).type,
        })),
      };
    }).filter(Boolean);
    let visibleRelationships = relationships;
    if (authorAccess && !authorAccess.isTenantUser) {
      if (!authorAccess.roleId || objectIds.length === 0) {
        customObjects = [];
        visibleRelationships = relationships.filter(item => (
          item.parent.kind !== 'custom_object' && item.related.kind !== 'custom_object'
        ));
      } else {
        const { data: grants, error: grantError } = await db.from('custom_object_role_permission')
          .select('custom_object_id').eq('tenant_id', tenantId)
          .eq('role_id', authorAccess.roleId).eq('can_view_records', true)
          .in('custom_object_id', objectIds);
        throwDb(grantError);
        const grantedObjects = new Set((grants || []).map(item => String(item.custom_object_id)));
        const visibleObjectIds = customObjects.map(item => item.id)
          .filter(objectId => grantedObjects.has(String(objectId)));
        const { data: denied, error: deniedError } = visibleObjectIds.length
          ? await db.from('custom_object_field_role_permission')
            .select('custom_object_id, field_id, access_level')
            .eq('tenant_id', tenantId).eq('role_id', authorAccess.roleId)
            .eq('access_level', 'none').in('custom_object_id', visibleObjectIds)
          : { data: [], error: null };
        throwDb(deniedError);
        const deniedKeys = new Set((denied || [])
          .map(item => `${item.custom_object_id}:${item.field_id}`));
        customObjects = customObjects.filter(object => grantedObjects.has(String(object.id)))
          .map(object => ({
            ...object,
            fields: object.fields.filter(field => !deniedKeys.has(`${object.id}:${field.id}`)),
          }))
          .filter(object => object.fields.some(field => (
            String(field.id) === String(object.primary_display_field_id)
          )));
        const accessible = new Set(customObjects.map(object => String(object.id)));
        visibleRelationships = relationships.filter(item => (
          (item.parent.kind !== 'custom_object'
            || accessible.has(String(item.parent.custom_object_id)))
          && (item.related.kind !== 'custom_object'
            || accessible.has(String(item.related.custom_object_id)))
        ));
      }
    }
    return { data: visibleRelationships, custom_objects: customObjects };
  }
  async function loadEndpoint(kind, id, objectId) {
    let q = db.from(TABLES[kind]).select('*').eq('tenant_id', tenantId).eq('id', id);
    if (kind === 'custom_object') q = q.eq('custom_object_id', objectId).is('archived_at', null);
    const { data, error } = await q.maybeSingle(); throwDb(error); return data;
  }
  // Internal call context only: JSON request/answer objects cannot supply a Map.
  // Bind the exception to a field as well as an ID, never to all tenant records.
  const isServerCreatedOrganization = (context, field, id) =>
    context instanceof Map && field?.type === 'organisation_dropdown'
    && hasEnabledFormNotListedChoice(field) && context.get(field.id) === id;
  const resolveOrganizationReference = (context, field, value) => {
    if (!isFormNotListedValue(value) || !(context instanceof Map)) return value;
    const id = context.get(field?.id);
    return id && isServerCreatedOrganization(context, field, id) ? id : value;
  };
  async function verified({ form, fieldId, parentRecordId, rootForm, containerFieldId, serverCreatedOrganizations }) {
    const saved = savedRelationshipField(form, fieldId, { rootForm, containerFieldId });
    const parentRow = await loadEndpoint(saved.parent.kind, parentRecordId, saved.parent.custom_object_id);
    if (!parentRow) throw new FormRelationshipError(404, 'Relationship parent not found');
    if (saved.parent.kind === 'organization' && !isServerCreatedOrganization(serverCreatedOrganizations, saved.parentField, parentRecordId)) { try { const ok = await isOrganizationEligibleForField({ db, tenantId, organization: parentRow, field: saved.parentField }); if (!ok) throw new FormRelationshipError(400, 'Organization is not eligible for this field'); } catch (e) { if (e instanceof FormRelationshipError) throw e; throwDb(e); } }
    const { data: definition, error } = await db.from('custom_object_relationship_definition').select('*').eq('tenant_id', tenantId).eq('id', saved.relationshipDefinitionId).eq('status', 'active').maybeSingle(); throwDb(error);
    const ps = saved.parent.side; const matches = ['source', 'target'].filter(side => {
      const p = endpoint(definition, side); const r = endpoint(definition, side === 'source' ? 'target' : 'source');
      return p && r && (!ps || ps === side) && p.kind === saved.parent.kind && String(p.custom_object_id) === String(saved.parent.custom_object_id) && r.kind === saved.related.kind && String(r.custom_object_id) === String(saved.related.custom_object_id) && definition[`show_on_${side}`] !== false;
    });
    if (!definition || definition.archived_at || matches.length !== 1) throw new FormRelationshipError(409, 'Saved relationship configuration is unavailable');
    const parentSide = matches[0]; let relatedObject = null; let primaryField = null;
    if (saved.related.kind === 'custom_object') { relatedObject = await activeObject(saved.related.custom_object_id); if (!relatedObject || String(relatedObject.primary_display_field_id) !== String(saved.related.primary_display_field_id)) throw new FormRelationshipError(409, 'Related Custom Object is unavailable'); const r = await db.from('preference_field').select('*').eq('tenant_id', tenantId).eq('id', relatedObject.primary_display_field_id).eq('custom_object_id', relatedObject.id).eq('entity_scope', 'custom_object').eq('is_active', true).maybeSingle(); throwDb(r.error); primaryField = r.data; if (!primaryField || !getCustomObjectFieldMetadata(primaryField).key) throw new FormRelationshipError(409, 'Related Custom Object display field is unavailable'); }
    return { saved, parentRow, definition, parentSide, relatedSide: parentSide === 'source' ? 'target' : 'source', relatedObject, primaryField };
  }
  async function relationshipOptions({ formId, slug, form: supplied, fieldId, parentRecordId, organizationId, dependencyAnswers, query = {}, activeOnly = true, rootForm, containerFieldId }) {
    const authoritativeRoot = rootForm || supplied;
    const container = containerFieldId && (authoritativeRoot?.fields || [])
      .find(item => String(item?.id) === String(containerFieldId));
    const sourceField = container && repeatableRowChildren(container)
      .find(item => String(item?.id) === String(fieldId));
    if (sourceField?.option_source !== undefined) {
      if (!isCustomObjectRowSource(sourceField)) {
        throw new FormRelationshipError(409, 'Saved Custom Object row source configuration is invalid');
      }
      return rowSourceOptions({
        form: supplied,
        fieldId,
        rootForm: authoritativeRoot,
        containerFieldId,
        dependencyAnswers,
        query,
      });
    }
    parentRecordId = parentRecordId || organizationId; if (!fieldId || !parentRecordId) throw new FormRelationshipError(400, 'fieldId and parentRecordId are required');
    const form = supplied || await loadForm({ formId, slug, activeOnly }); const state = await verified({ form, fieldId, parentRecordId, rootForm: rootForm || form, containerFieldId });
    const edges = await readAll(() => db.from('custom_object_relationship').select('id, source_record_id, target_record_id').eq('tenant_id', tenantId).eq('relationship_definition_id', state.definition.id).eq(`${state.parentSide}_record_id`, parentRecordId).is('archived_at', null));
    const ids = [...new Set(edges.map(e => e[`${state.relatedSide}_record_id`]).filter(Boolean))]; const rows = []; for (let i = 0; i < ids.length; i += 500) rows.push(...await readAll(() => { let q = db.from(TABLES[state.saved.related.kind]).select('*').eq('tenant_id', tenantId).in('id', ids.slice(i, i + 500)); if (state.saved.related.kind === 'custom_object') q = q.eq('custom_object_id', state.relatedObject.id).is('archived_at', null); return q; }));
    const options = rows.map(row => ({ id: row.id, label: state.saved.related.kind === 'organization' ? row.name || row.id : state.saved.related.kind === 'organization_group' ? row.name || row.id : resolveCustomObjectDisplayValue({ objectDefinition: state.relatedObject, record: row, fields: [state.primaryField] }) })).sort((a, b) => String(a.label).localeCompare(String(b.label)) || String(a.id).localeCompare(String(b.id)));
    const p = pagination(query); return { data: options.slice((p.page - 1) * p.pageSize, p.page * p.pageSize), total: options.length, page: p.page, pageSize: p.pageSize };
  }
  async function rowSourceState({ form, fieldId, rootForm, containerFieldId }) {
    if (!containerFieldId) throw new FormRelationshipError(409, 'Custom Object row sources require a repeatable row');
    const container = (rootForm?.fields || []).find(item => String(item?.id) === String(containerFieldId));
    if (!container || !isRepeatableRowField(container)) throw new FormRelationshipError(404, 'Repeatable row field not found');
    const siblings = repeatableRowChildren(container);
    const field = siblings.find(item => String(item?.id) === String(fieldId));
    if (!field || !isCustomObjectRowSource(field)) throw new FormRelationshipError(404, 'Custom Object row source field not found');
    const configuration = validateRowSourceConfiguration(field, siblings);
    if (configuration !== true && configuration?.valid !== true && configuration?.ok !== true) {
      const message = configuration?.error || configuration?.errors?.[0]?.message || 'Saved Custom Object row source configuration is invalid';
      throw new FormRelationshipError(409, message);
    }
    const source = field.option_source;
    if (isRelationshipMultiSelect(field)) {
      throw new FormRelationshipError(409, 'Custom Object row sources must be single-select');
    }
    const object = await activeObject(source.custom_object_id);
    if (!object || String(object.primary_display_field_id) !== String(source.primary_display_field_id)) {
      throw new FormRelationshipError(409, 'Saved Custom Object row source is unavailable');
    }
    const neededIds = [...new Set([
      source.primary_display_field_id,
      ...(isDistinctRowSource(field) ? [source.value_field_id] : []),
      ...(source.filters || []).map(filter => filter.field_id),
    ].filter(Boolean).map(String))];
    const { data: fields, error } = await db.from('preference_field')
      .select('id, custom_object_id, name, label, field_type, is_active')
      .eq('tenant_id', tenantId).eq('custom_object_id', object.id)
      .eq('entity_scope', 'custom_object').eq('is_active', true)
      .in('id', neededIds);
    throwDb(error);
    const byId = new Map((fields || []).map(item => [String(item.id), item]));
    if (neededIds.some(id => !byId.has(id)
        || !getCustomObjectFieldMetadata(byId.get(id)).active
        || !/^[a-z][a-z0-9_]{0,99}$/.test(getCustomObjectFieldMetadata(byId.get(id)).key))) {
      throw new FormRelationshipError(409, 'Saved Custom Object row source field is unavailable');
    }
    const scalarFieldIds = [
      ...(isDistinctRowSource(field) ? [source.value_field_id] : []),
      ...(source.filters || []).map(filter => filter.field_id),
    ];
    if (scalarFieldIds.some(id => !ROW_SOURCE_SCALAR_FIELD_TYPES.has(getCustomObjectFieldMetadata(byId.get(String(id))).type))) {
      throw new FormRelationshipError(409, 'Saved Custom Object row source field is not scalar');
    }
    async function dependencyDomain(dependency) {
      if (isDistinctRowSource(dependency)) {
        const dependencySource = dependency.option_source;
        const { data, error: dependencyError } = await db.from('preference_field')
          .select('id, custom_object_id, name, field_type, is_active')
          .eq('tenant_id', tenantId).eq('id', dependencySource.value_field_id)
          .eq('custom_object_id', dependencySource.custom_object_id)
          .eq('entity_scope', 'custom_object').eq('is_active', true).maybeSingle();
        throwDb(dependencyError);
        return customObjectRowSourceDomain(data && getCustomObjectFieldMetadata(data));
      }
      if (dependency?.type === 'custom_field') {
        if (!dependency.custom_field_id) return null;
        const { data, error: customFieldError } = await db.from('preference_field')
          .select('id, field_type, is_active')
          .eq('tenant_id', tenantId).eq('id', dependency.custom_field_id)
          .eq('is_active', true).maybeSingle();
        throwDb(customFieldError);
        return data ? rowSourceValueDomain(data.field_type) : null;
      }
      return rowSourceValueDomain(dependency?.type);
    }
    for (const filter of source.filters || []) {
      const dependency = siblings.find(item => String(item?.id) === String(filter.source_field_id));
      const targetDomain = customObjectRowSourceDomain(getCustomObjectFieldMetadata(byId.get(String(filter.field_id))));
      if (!targetDomain || await dependencyDomain(dependency) !== targetDomain) {
        throw new FormRelationshipError(409, 'Saved Custom Object row source filter types are incompatible');
      }
    }
    let relationship = null;
    if (field.parent_field_id || field.relationship_definition_id) {
      const saved = savedRelationshipField(form, fieldId, { rootForm, containerFieldId });
      if (String(saved.related.custom_object_id) !== String(source.custom_object_id)
          || String(saved.related.primary_display_field_id) !== String(source.primary_display_field_id)) {
        throw new FormRelationshipError(409, 'Saved Custom Object row source relationship is invalid');
      }
      relationship = saved;
    }
    if (isDistinctRowSource(field) && !relationship) {
      throw new FormRelationshipError(409, 'Distinct Custom Object row sources require a relationship parent');
    }
    const projection = new Map();
    neededIds.forEach((fieldId, index) => projection.set(fieldId, `source_value_${index}`));
    return { field, source, object, fields: byId, relationship, projection };
  }
  function projectedFieldValue(record, state, fieldId) {
    const alias = state.projection.get(String(fieldId));
    if (alias && Object.prototype.hasOwnProperty.call(record || {}, alias)) return record[alias];
    const metadata = getCustomObjectFieldMetadata(state.fields.get(String(fieldId)));
    return record?.data?.[metadata.key];
  }
  function canonicalFilterValue(value, metadata) {
    if (isRepeatableValueEmpty(value) || Array.isArray(value) || typeof value === 'object') {
      return { valid: false };
    }
    const domain = customObjectRowSourceDomain(metadata);
    if (domain === 'number') {
      if (typeof value !== 'number' && typeof value !== 'string') return { valid: false };
      const number = typeof value === 'number' ? value : Number(String(value).trim());
      return Number.isFinite(number) ? { valid: true, value: number } : { valid: false };
    }
    if (domain === 'boolean') {
      if (value === true || value === 'true') return { valid: true, value: true };
      if (value === false || value === 'false') return { valid: true, value: false };
      return { valid: false };
    }
    if (domain === 'date') {
      return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
        ? { valid: true, value }
        : { valid: false };
    }
    return domain === 'string' && typeof value === 'string'
      ? { valid: true, value }
      : { valid: false };
  }
  function rowMatchesFilters(record, state, dependencyAnswers) {
    return (state.source.filters || []).every(filter => {
      const metadata = getCustomObjectFieldMetadata(state.fields.get(String(filter.field_id)));
      const actual = projectedFieldValue(record, state, filter.field_id);
      const expected = dependencyAnswers[filter.source_field_id];
      const canonicalActual = canonicalFilterValue(actual, metadata);
      const canonicalExpected = canonicalFilterValue(expected, metadata);
      return canonicalActual.valid && canonicalExpected.valid
        && canonicalActual.value === canonicalExpected.value;
    });
  }
  async function candidateRowSourceRecords(state, dependencyAnswers) {
    let candidateIds = null;
    if (state.relationship) {
      const parentRecordId = dependencyAnswers[state.field.parent_field_id];
      if (typeof parentRecordId !== 'string' || !parentRecordId) return [];
      const verifiedState = await verified({
        form: { fields: repeatableRowChildren((state.rootForm.fields || []).find(item => String(item.id) === String(state.containerFieldId))) },
        fieldId: state.field.id,
        parentRecordId,
        rootForm: state.rootForm,
        containerFieldId: state.containerFieldId,
      });
      const edges = await readAll(() => orderedById(db.from('custom_object_relationship')
        .select(`id, ${verifiedState.relatedSide}_record_id`)
        .eq('tenant_id', tenantId).eq('relationship_definition_id', verifiedState.definition.id)
        .eq(`${verifiedState.parentSide}_record_id`, parentRecordId).is('archived_at', null)), 100, 5001);
      if (edges.length > 5000) throw new FormRelationshipError(409, 'Custom Object row source contains too many related records');
      candidateIds = [...new Set(edges.map(edge => edge[`${verifiedState.relatedSide}_record_id`]).filter(Boolean))];
      if (!candidateIds.length) return [];
    }
    const projectedValues = [...state.projection.entries()].map(([fieldId, alias]) => {
      const key = getCustomObjectFieldMetadata(state.fields.get(fieldId)).key;
      return `${alias}:data->${key}`;
    });
    const projection = ['id', ...projectedValues].join(', ');
    const rows = [];
    const batches = candidateIds ? Array.from({ length: Math.ceil(candidateIds.length / 100) }, (_, index) => candidateIds.slice(index * 100, (index + 1) * 100)) : [null];
    for (const ids of batches) {
      const loaded = await readAll(() => {
        let query = orderedById(db.from('custom_object_record').select(projection)
          .eq('tenant_id', tenantId).eq('custom_object_id', state.object.id).is('archived_at', null));
        if (ids) query = query.in('id', ids);
        return query;
      }, 100, Math.min(5001 - rows.length, 5001));
      rows.push(...loaded);
      if (rows.length > 5000) throw new FormRelationshipError(409, 'Custom Object row source contains too many records');
    }
    return rows.filter(record => rowMatchesFilters(record, state, dependencyAnswers));
  }
  async function resolveRowSourceOptions({ form, fieldId, rootForm, containerFieldId, dependencyAnswers = {} }) {
    if (!dependencyAnswers || typeof dependencyAnswers !== 'object' || Array.isArray(dependencyAnswers)) {
      throw new FormRelationshipError(400, 'dependencyAnswers must be an object');
    }
    const state = await rowSourceState({ form, fieldId, rootForm, containerFieldId });
    state.rootForm = rootForm;
    state.containerFieldId = containerFieldId;
    const allowedDependencies = new Set(rowSourceDependencyIds(state.field).map(String));
    if (state.relationship?.parentField?.id) {
      allowedDependencies.add(String(state.relationship.parentField.id));
    }
    if (Object.keys(dependencyAnswers).some(id => !allowedDependencies.has(String(id)))) {
      throw new FormRelationshipError(400, 'dependencyAnswers contains an unsupported field');
    }
    if ([...allowedDependencies].some(id => {
      const value = dependencyAnswers[id];
      return isRepeatableValueEmpty(value) || Array.isArray(value) || typeof value === 'object';
    })) return [];
    const records = await candidateRowSourceRecords(state, dependencyAnswers);
    let options;
    if (isDistinctRowSource(state.field)) {
      options = [...new Set(records.map(record => projectedFieldValue(record, state, state.source.value_field_id))
        .filter(value => value !== undefined && value !== null && String(value).trim() !== '')
        .map(String))].map(value => ({ id: value, label: value }));
    } else {
      const primary = state.fields.get(String(state.source.primary_display_field_id));
      const primaryKey = getCustomObjectFieldMetadata(primary).key;
      options = records.map(record => ({
        id: record.id,
        label: resolveCustomObjectDisplayValue({
          objectDefinition: state.object,
          record: {
            ...record,
            data: { [primaryKey]: projectedFieldValue(record, state, state.source.primary_display_field_id) },
          },
          fields: [primary],
        }),
      }));
    }
    options.sort((a, b) => String(a.label).localeCompare(String(b.label)) || String(a.id).localeCompare(String(b.id)));
    return options;
  }
  async function rowSourceOptions({ form, fieldId, rootForm, containerFieldId, dependencyAnswers = {}, query = {} }) {
    const options = await resolveRowSourceOptions({
      form, fieldId, rootForm, containerFieldId, dependencyAnswers,
    });
    if (query.all === true) {
      return { data: options, total: options.length, page: 1, pageSize: 5000 };
    }
    const p = pagination(query);
    return { data: options.slice((p.page - 1) * p.pageSize, p.page * p.pageSize), total: options.length, page: p.page, pageSize: p.pageSize };
  }
  async function validatePersistedRowSource({ form, fieldId, containerFieldId }) {
    const container = (form.fields || [])
      .find(item => String(item?.id) === String(containerFieldId));
    const children = repeatableRowChildren(container);
    const configuredField = children.find(item => String(item?.id) === String(fieldId));
    if (configuredField?.option_source !== undefined && isRelationshipMultiSelect(configuredField)) {
      throw new FormRelationshipError(409, 'Custom Object row sources must be single-select');
    }
    const virtualForm = { ...form, fields: children };
    const state = await rowSourceState({
      form: virtualForm,
      fieldId,
      rootForm: form,
      containerFieldId,
    });
    if (state.relationship) {
      await validateRecordReferencePicker({
        form: virtualForm,
        fieldId,
        rootForm: form,
        containerFieldId,
      });
    }
  }
  async function validateSubmission({ form, submissionData = {}, cache = new Map(), rootForm, rootSubmissionData, containerFieldId, allowMissingNotListedText, hiddenFieldIds, visibilityOptions = {}, serverCreatedOrganizations }) {
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
    for (const field of fields) {
      const selected = fieldValue(submissionData, field);
      if (containsFormNotListedValue(selected) && !hasEnabledFormNotListedChoice(field)) {
        throw new FormRelationshipError(400, 'Invalid not-listed selection');
      }
      const inclusiveRelationshipOther = isRelationshipMultiSelect(field);
      if (Array.isArray(selected) && containsFormNotListedValue(selected)
          && selected.length !== 1 && !inclusiveRelationshipOther) {
        throw new FormRelationshipError(400, 'Not-listed selection must be exclusive');
      }
      if ((field?.type === 'countries' || field?.type === 'category_multiselect')
          && isFormNotListedValue(selected)) {
        throw new FormRelationshipError(400, 'Invalid multi-select not-listed selection');
      }
      if (!conditionalSelectionAllowed(selected, resolveConditionalFilter(field, submissionData, fields))) {
        throw new FormRelationshipError(400, 'Invalid conditional field selection');
      }
    }
    for (const field of fields.filter(x => x?.type === 'organisation_dropdown')) {
      const id = resolveOrganizationReference(
        containerFieldId ? undefined : serverCreatedOrganizations,
        field,
        fieldValue(submissionData, field),
      );
      if (id == null || id === '' || isFormNotListedValue(id)) continue;
      if (typeof id !== 'string' && typeof id !== 'number') throw new FormRelationshipError(400, 'Invalid organization selection');
      const key = `organization:${id}`;
      let organization = cache.get(key);
      if (organization === undefined) { const result = await db.from('organization').select('*').eq('tenant_id', tenantId).eq('id', id).maybeSingle(); throwDb(result.error); organization = result.data || null; cache.set(key, organization); }
      if (!organization) throw new FormRelationshipError(400, 'Invalid organization selection');
      if (!containerFieldId && isServerCreatedOrganization(serverCreatedOrganizations, field, id)) continue;
      const resolution = resolveConditionalFilter(field, submissionData, fields);
      try {
        const eligible = await isOrganizationEligibleForField({ db, tenantId, organization, field });
        const conditional = !resolution.orgFilter || await isOrganizationEligibleForField({ db, tenantId, organization, field: { org_filter: resolution.orgFilter } });
        if (!eligible || !conditional) throw new FormRelationshipError(400, 'Invalid organization selection');
      } catch (error) { if (error instanceof FormRelationshipError) throw error; throwDb(error); }
    }
    for (const field of fields.filter(x => x?.type === 'relationship_dropdown')) {
      const selected = fieldValue(submissionData, field);
      if (selected == null) continue;
      const mode = relationshipSelectionMode(field);
      if ((mode === RELATIONSHIP_SELECTION_MULTIPLE && !Array.isArray(selected))
          || (mode === RELATIONSHIP_SELECTION_SINGLE && Array.isArray(selected))) {
        throw new FormRelationshipError(400, 'Invalid relationship selection mode');
      }
      if (selected === '' || isFormNotListedValue(selected)) continue;
      const submittedIds = (Array.isArray(selected) ? selected : [selected]).filter(Boolean);
      if (submittedIds.length === 0) continue;
      const comparableIds = submittedIds.map(String);
      if (new Set(comparableIds).size !== comparableIds.length) {
        throw new FormRelationshipError(400, 'Duplicate relationship selection');
      }
      const recordIds = submittedIds.filter(recordId => !isFormNotListedValue(recordId));
      if (recordIds.some(recordId =>
        isFormNoRelationshipValue(recordId)
          || (typeof recordId !== 'string' && typeof recordId !== 'number'))) {
        throw new FormRelationshipError(400, 'Invalid relationship selection');
      }
      if (recordIds.length === 0 && containsFormNotListedValue(selected)) continue;
      if (recordIds.length === 0) throw new FormRelationshipError(400, 'Invalid relationship selection');
      if (isCustomObjectRowSource(field)) {
        if (!containerFieldId || Array.isArray(selected) || typeof selected !== 'string') {
          throw new FormRelationshipError(400, 'Invalid Custom Object row source selection');
        }
        const dependencyIds = new Set(rowSourceDependencyIds(field));
        if (field.parent_field_id) dependencyIds.add(field.parent_field_id);
        const dependencies = Object.fromEntries([...dependencyIds].map(id => [id, fieldValue(submissionData, { id })]));
        const sourceCacheKey = `row-source:${containerFieldId}:${field.id}:${JSON.stringify(
          [...dependencyIds].sort().map(id => [id, dependencies[id]]),
        )}`;
        let eligibleIds = cache.get(sourceCacheKey);
        if (!eligibleIds) {
          const options = await resolveRowSourceOptions({
            form, fieldId: field.id, rootForm: rootForm || form, containerFieldId,
            dependencyAnswers: dependencies,
          });
          eligibleIds = new Set(options.map(option => String(option.id)));
          cache.set(sourceCacheKey, eligibleIds);
        }
        const found = eligibleIds.has(selected);
        if (!found) throw new FormRelationshipError(400, 'Invalid Custom Object row source selection');
        continue;
      }
      const saved = savedRelationshipField(form, field.id, {
        rootForm: rootForm || form,
        containerFieldId,
      });
      const parentData = saved.parentScope === 'form' && containerFieldId
        ? (rootSubmissionData || submissionData)
        : submissionData;
      const parentRecordId = resolveOrganizationReference(
        containerFieldId ? undefined : serverCreatedOrganizations,
        saved.parentField,
        fieldValue(parentData, saved.parentField),
      );
      if (!parentRecordId || isFormNotListedValue(parentRecordId)) {
        throw new FormRelationshipError(400, 'Invalid relationship selection');
      }
      const state = await verified({
        form,
        fieldId: field.id,
        parentRecordId,
        rootForm: rootForm || form,
        containerFieldId,
        serverCreatedOrganizations: containerFieldId ? undefined : serverCreatedOrganizations,
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
  // A resolver may receive the Not-listed sentinel, so validateSubmission
  // intentionally does not resolve an option. This separate persisted-metadata
  // check closes that gap before a resolver can create a record.
  async function validateRecordReferencePicker({ form, fieldId, rootForm, containerFieldId }) {
    const authoritativeRoot = rootForm || form;
    const container = containerFieldId && (authoritativeRoot?.fields || [])
      .find(item => String(item?.id) === String(containerFieldId));
    const sourceField = container
      ? repeatableRowChildren(container).find(item => String(item?.id) === String(fieldId))
      : (form?.fields || []).find(item => String(item?.id) === String(fieldId));
    if (sourceField?.option_source !== undefined) {
      if (!isCustomObjectRowSource(sourceField) || isDistinctRowSource(sourceField)) {
        throw new FormRelationshipError(409, 'Saved record-reference row source configuration is invalid');
      }
      const virtualForm = container ? { ...form, fields: repeatableRowChildren(container) } : form;
      const state = await rowSourceState({
        form: virtualForm,
        fieldId,
        rootForm: authoritativeRoot,
        containerFieldId,
      });
      if (!state.relationship) {
        return {
          field: state.field,
          related: {
            kind: 'custom_object',
            custom_object_id: state.object.id,
            primary_display_field_id: state.source.primary_display_field_id,
          },
          customObjectId: state.object.id,
          primaryDisplayFieldId: state.source.primary_display_field_id,
          optionSourceKind: 'records',
        };
      }
    }
    const saved = savedRelationshipField(form, fieldId, {
      rootForm: rootForm || form,
      containerFieldId,
    });
    const { data: definition, error } = await db.from('custom_object_relationship_definition')
      .select('*').eq('tenant_id', tenantId).eq('id', saved.relationshipDefinitionId)
      .eq('status', 'active').maybeSingle();
    throwDb(error);
    const parentSides = ['source', 'target'].filter(side => {
      const relatedSide = side === 'source' ? 'target' : 'source';
      return !definition?.archived_at
        && (!saved.parent.side || side === saved.parent.side)
        && definition?.[`${side}_kind`] === saved.parent.kind
        && String(definition?.[`${side}_custom_object_id`] || '') === String(saved.parent.custom_object_id || '')
        && definition?.[`${relatedSide}_kind`] === saved.related.kind
        && String(definition?.[`${relatedSide}_custom_object_id`] || '') === String(saved.related.custom_object_id || '')
        && definition?.[`show_on_${side}`] !== false;
    });
    if (parentSides.length !== 1) {
      throw new FormRelationshipError(409, 'Saved relationship configuration is unavailable');
    }
    if (saved.related.kind === 'custom_object') {
      const object = await activeObject(saved.related.custom_object_id);
      if (!object || String(object.primary_display_field_id) !== String(saved.related.primary_display_field_id)) {
        throw new FormRelationshipError(409, 'Related Custom Object is unavailable');
      }
      const { data: displayField, error: displayError } = await db.from('preference_field')
        .select('id').eq('tenant_id', tenantId)
        .eq('id', saved.related.primary_display_field_id)
        .eq('custom_object_id', saved.related.custom_object_id)
        .eq('entity_scope', 'custom_object').eq('is_active', true).maybeSingle();
      throwDb(displayError);
      if (!displayField) {
        throw new FormRelationshipError(409, 'Related Custom Object display field is unavailable');
      }
    }
    return saved;
  }
  return {
    loadForm,
    eligibleDefinitions,
    relationshipOptions,
    rowSourceOptions,
    validatePersistedRowSource,
    validateSubmission,
    validateRecordReferencePicker,
  };
}