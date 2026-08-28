import { getCustomObjectFieldMetadata, resolveCustomObjectDisplayValue } from './customObjectDomain.js';
import { isOrganizationEligibleForField } from './organizationEligibility.js';
import {
  conditionalSelectionAllowed,
  resolveConditionalFilter,
} from './formConditionalFilters.js';
import {
  containsFormNotListedValue,
  hasEnabledFormNotListedChoice,
  isFormNotListedValue,
} from '../../shared/formNotListedChoice.js';
import { isFormNoRelationshipValue } from '../../shared/formNoRelationshipChoice.js';

export class FormRelationshipError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function throwDb(error) {
  if (error) throw new FormRelationshipError(500, error.message || 'Database operation failed');
}

export function pagination(query = {}) {
  const page = Math.max(Number.parseInt(query.page, 10) || 1, 1);
  const pageSize = Math.min(Math.max(Number.parseInt(query.pageSize, 10) || 25, 1), 100);
  return { page, pageSize };
}

export function organizationRelationshipSide(definition) {
  const source = definition?.source_kind === 'organization'
    && definition.source_custom_object_id == null
    && definition.target_kind === 'custom_object'
    && Boolean(definition.target_custom_object_id);
  const target = definition?.target_kind === 'organization'
    && definition.target_custom_object_id == null
    && definition.source_kind === 'custom_object'
    && Boolean(definition.source_custom_object_id);
  if (source === target) return null;
  const organizationSide = source ? 'source' : 'target';
  return {
    organizationSide,
    relatedSide: organizationSide === 'source' ? 'target' : 'source',
    customObjectId: source
      ? definition.target_custom_object_id
      : definition.source_custom_object_id,
  };
}

export function savedRelationshipField(form, fieldId) {
  const fields = Array.isArray(form?.fields) ? form.fields : [];
  const index = fields.findIndex((field) => String(field?.id) === String(fieldId));
  if (index < 0) throw new FormRelationshipError(404, 'Relationship field not found');
  const field = fields[index];
  if (field?.type !== 'relationship_dropdown') {
    throw new FormRelationshipError(409, 'Saved field is not a relationship dropdown');
  }
  const parentFieldId = field.parent_field_id;
  const relationshipDefinitionId = field.relationship_definition_id;
  const customObjectId = field.custom_object_id;
  const primaryDisplayFieldId = field.custom_object_primary_display_field_id;
  if (!parentFieldId || !relationshipDefinitionId || !customObjectId || !primaryDisplayFieldId) {
    throw new FormRelationshipError(409, 'Saved relationship field configuration is incomplete');
  }
  const parentIndex = fields.findIndex((candidate) => String(candidate?.id) === String(parentFieldId));
  if (parentIndex < 0 || parentIndex >= index || fields[parentIndex]?.type !== 'organisation_dropdown') {
    throw new FormRelationshipError(409, 'Saved relationship field parent is invalid');
  }
  return {
    field,
    parentField: fields[parentIndex],
    relationshipDefinitionId,
    customObjectId,
    primaryDisplayFieldId,
  };
}

function publicDefinition(definition, side, object) {
  return {
    id: definition.id,
    relationship_key: definition.relationship_key,
    organization_side: side.organizationSide,
    label: definition[`${side.relatedSide}_label`],
    custom_object: {
      id: object.id,
      object_key: object.object_key,
      singular_label: object.singular_label,
      plural_label: object.plural_label,
      primary_display_field_id: object.primary_display_field_id,
    },
  };
}

function submittedFieldValue(submissionData, field) {
  const byId = submissionData?.[field?.id];
  if (byId !== undefined) return byId;
  if (!field?.name) return undefined;
  return submissionData?.[field.name];
}

export function createFormRelationshipService({ db, tenantId }) {
  if (!db) throw new FormRelationshipError(503, 'Database unavailable');
  if (!tenantId) throw new FormRelationshipError(400, 'Tenant context not found');

  async function readAll(buildQuery, chunkSize = 500) {
    const rows = [];
    for (let from = 0;; from += chunkSize) {
      const { data, error } = await buildQuery().range(from, from + chunkSize - 1);
      throwDb(error);
      rows.push(...(data || []));
      if (!data || data.length < chunkSize) return rows;
    }
  }

  async function loadForm({ formId, slug, activeOnly = false }) {
    let query = db.from('form').select('*').eq('tenant_id', tenantId);
    if (formId) query = query.eq('id', formId);
    else if (slug) query = query.eq('slug', slug);
    else throw new FormRelationshipError(400, 'Form is required');
    if (activeOnly) query = query.eq('is_active', true);
    const { data, error } = await query.maybeSingle();
    throwDb(error);
    if (!data) throw new FormRelationshipError(404, 'Form not found');
    return data;
  }

  async function eligibleDefinitions(formId) {
    await loadForm({ formId });
    const { data: definitions, error } = await db.from('custom_object_relationship_definition')
      .select('*')
      .eq('tenant_id', tenantId)
      .eq('status', 'active')
      .order('relationship_key', { ascending: true })
      .order('id', { ascending: true });
    throwDb(error);
    const candidates = (definitions || []).map((definition) => ({
      definition,
      side: organizationRelationshipSide(definition),
    })).filter(({ definition, side }) => side && definition[`show_on_${side.organizationSide}`] !== false);
    const objectIds = [...new Set(candidates.map(({ side }) => side.customObjectId))];
    if (objectIds.length === 0) return { data: [] };
    const { data: objects, error: objectError } = await db.from('custom_object_definition')
      .select('id, object_key, singular_label, plural_label, primary_display_field_id, status')
      .eq('tenant_id', tenantId)
      .eq('status', 'active')
      .in('id', objectIds);
    throwDb(objectError);
    const byId = new Map((objects || []).map((object) => [object.id, object]));
    return {
      data: candidates
        .filter(({ side }) => byId.has(side.customObjectId))
        .map(({ definition, side }) => publicDefinition(definition, side, byId.get(side.customObjectId))),
    };
  }

  async function relationshipOptions({ formId, slug, form: suppliedForm, fieldId, organizationId, query = {}, activeOnly = true }) {
    if (!fieldId || !organizationId) {
      throw new FormRelationshipError(400, 'fieldId and organizationId are required');
    }
    const form = suppliedForm || await loadForm({ formId, slug, activeOnly });
    const saved = savedRelationshipField(form, fieldId);
    const { data: organization, error: organizationError } = await db.from('organization')
      .select('*')
      .eq('tenant_id', tenantId)
      .eq('id', organizationId)
      .maybeSingle();
    throwDb(organizationError);
    if (!organization) throw new FormRelationshipError(404, 'Organization not found');
    try {
      if (!await isOrganizationEligibleForField({
        db, tenantId, organization, field: saved.parentField,
      })) {
        throw new FormRelationshipError(400, 'Organization is not eligible for this field');
      }
    } catch (error) {
      if (error instanceof FormRelationshipError) throw error;
      throwDb(error);
    }

    const { data: definition, error: definitionError } = await db
      .from('custom_object_relationship_definition').select('*')
      .eq('tenant_id', tenantId)
      .eq('id', saved.relationshipDefinitionId)
      .eq('status', 'active')
      .maybeSingle();
    throwDb(definitionError);
    const side = organizationRelationshipSide(definition);
    if (!definition || !side
      || definition[`show_on_${side.organizationSide}`] === false
      || String(side.customObjectId) !== String(saved.customObjectId)) {
      throw new FormRelationshipError(409, 'Saved relationship configuration is unavailable');
    }

    const { data: object, error: objectError } = await db.from('custom_object_definition')
      .select('*')
      .eq('tenant_id', tenantId)
      .eq('id', saved.customObjectId)
      .eq('status', 'active')
      .maybeSingle();
    throwDb(objectError);
    if (!object) throw new FormRelationshipError(409, 'Related Custom Object is unavailable');
    if (String(object.primary_display_field_id) !== String(saved.primaryDisplayFieldId)) {
      throw new FormRelationshipError(409, 'Saved relationship display configuration is unavailable');
    }

    const { data: primaryField, error: fieldError } = await db.from('preference_field')
      .select('*')
      .eq('tenant_id', tenantId)
      .eq('id', object.primary_display_field_id)
      .eq('custom_object_id', object.id)
      .eq('entity_scope', 'custom_object')
      .eq('is_active', true)
      .maybeSingle();
    throwDb(fieldError);
    if (!primaryField || !getCustomObjectFieldMetadata(primaryField).key) {
      throw new FormRelationshipError(409, 'Related Custom Object display field is unavailable');
    }

    const edges = await readAll(() => db.from('custom_object_relationship')
      .select('id, source_record_id, target_record_id')
      .eq('tenant_id', tenantId)
      .eq('relationship_definition_id', definition.id)
      .eq(`${side.organizationSide}_record_id`, organization.id)
      .is('archived_at', null)
      .order(`${side.relatedSide}_record_id`, { ascending: true })
      .order('id', { ascending: true }));
    const recordIds = [...new Set((edges || []).map((edge) => edge[`${side.relatedSide}_record_id`]).filter(Boolean))];
    let records = [];
    for (let offset = 0; offset < recordIds.length; offset += 500) {
      const ids = recordIds.slice(offset, offset + 500);
      const batch = await readAll(() => db.from('custom_object_record').select('*')
        .eq('tenant_id', tenantId)
        .eq('custom_object_id', object.id)
        .is('archived_at', null)
        .in('id', ids));
      records.push(...batch);
    }
    const options = records.map((record) => ({
      id: record.id,
      label: resolveCustomObjectDisplayValue({
        objectDefinition: object,
        record,
        fields: [primaryField],
      }),
    })).sort((left, right) => (
      String(left.label).localeCompare(String(right.label)) || String(left.id).localeCompare(String(right.id))
    ));
    const p = pagination(query);
    const from = (p.page - 1) * p.pageSize;
    return {
      data: options.slice(from, from + p.pageSize),
      total: options.length,
      page: p.page,
      pageSize: p.pageSize,
    };
  }

  async function validateSubmission({ form, submissionData = {}, cache = new Map() }) {
    const fields = Array.isArray(form?.fields) ? form.fields : [];
    for (const field of fields) {
      const selected = submittedFieldValue(submissionData, field);
      if (containsFormNotListedValue(selected) && !hasEnabledFormNotListedChoice(field)) {
        throw new FormRelationshipError(400, 'Invalid not-listed selection');
      }
      if (Array.isArray(selected) && containsFormNotListedValue(selected) && selected.length !== 1) {
        throw new FormRelationshipError(400, 'Not-listed selection must be exclusive');
      }
      if (
        (field?.type === 'countries' || field?.type === 'category_multiselect')
        && isFormNotListedValue(selected)
      ) {
        throw new FormRelationshipError(400, 'Invalid multi-select not-listed selection');
      }
      const resolution = resolveConditionalFilter(field, submissionData, fields);
      if (!conditionalSelectionAllowed(selected, resolution)) {
        throw new FormRelationshipError(400, 'Invalid conditional field selection');
      }
      if (field?.type !== 'organisation_dropdown'
          || selected === undefined || selected === null || selected === '') continue;
      if (isFormNotListedValue(selected)) continue;
      if (typeof selected !== 'string' && typeof selected !== 'number') {
        throw new FormRelationshipError(400, 'Invalid organization selection');
      }
      const organizationKey = `organization:${selected}`;
      let organization = cache.get(organizationKey);
      if (organization === undefined) {
        const result = await db.from('organization')
          .select('*')
          .eq('tenant_id', tenantId)
          .eq('id', selected)
          .maybeSingle();
        throwDb(result.error);
        organization = result.data || null;
        cache.set(organizationKey, organization);
      }
      if (!organization) throw new FormRelationshipError(400, 'Invalid organization selection');
      try {
        const staticallyEligible = await isOrganizationEligibleForField({
          db, tenantId, organization, field,
        });
        const conditionallyEligible = !resolution.orgFilter
          || await isOrganizationEligibleForField({
            db, tenantId, organization, field: { org_filter: resolution.orgFilter },
          });
        if (!staticallyEligible || !conditionallyEligible) {
          throw new FormRelationshipError(400, 'Invalid organization selection');
        }
      } catch (error) {
        if (error instanceof FormRelationshipError) throw error;
        throwDb(error);
      }
    }
    for (const field of fields) {
      if (field?.type !== 'relationship_dropdown') continue;
      const recordId = submittedFieldValue(submissionData, field);
      if (recordId === undefined || recordId === null || recordId === '') continue;
      if (isFormNotListedValue(recordId)) continue;
      if (isFormNoRelationshipValue(recordId)) {
        throw new FormRelationshipError(400, 'Invalid relationship selection');
      }
      if (typeof recordId !== 'string' && typeof recordId !== 'number') {
        throw new FormRelationshipError(400, 'Invalid relationship selection');
      }
      const saved = savedRelationshipField(form, field.id);
      const organizationId = submittedFieldValue(submissionData, saved.parentField);
      if (isFormNotListedValue(organizationId)) {
        throw new FormRelationshipError(400, 'Invalid relationship selection');
      }
      if (!organizationId || (typeof organizationId !== 'string' && typeof organizationId !== 'number')) {
        throw new FormRelationshipError(400, 'Invalid relationship selection');
      }
      const validatedSelectionKey = `relationship-selection:${field.id}:${saved.relationshipDefinitionId}:${saved.customObjectId}:${organizationId}:${recordId}`;
      if (cache.get(validatedSelectionKey) === true) continue;
      // This is deliberately unpaginated in effect: a selected ID must be
      // checked directly, not merely against the first page of options.
      const relationshipKey = `relationship:${field.id}:${saved.relationshipDefinitionId}:${saved.customObjectId}:${organizationId}`;
      let options = cache.get(relationshipKey);
      if (!options) options = await relationshipOptions({
        formId: form.id,
        form,
        fieldId: field.id,
        organizationId,
        query: { page: 1, pageSize: 100 },
        activeOnly: false,
      });
      cache.set(relationshipKey, options);
      if (!options.data.some((option) => String(option.id) === String(recordId))) {
        // There can be more than 100 options. Query the exact row through the
        // same tenant-scoped relationship and record lifecycle constraints.
        const { data: definition, error: definitionError } = await db
          .from('custom_object_relationship_definition').select('*')
          .eq('tenant_id', tenantId).eq('id', saved.relationshipDefinitionId)
          .eq('status', 'active').maybeSingle();
        throwDb(definitionError);
        const side = organizationRelationshipSide(definition);
        const { data: edge, error: edgeError } = await db.from('custom_object_relationship')
          .select('id')
          .eq('tenant_id', tenantId)
          .eq('relationship_definition_id', saved.relationshipDefinitionId)
          .eq(`${side?.organizationSide}_record_id`, organizationId)
          .eq(`${side?.relatedSide}_record_id`, recordId)
          .is('archived_at', null)
          .maybeSingle();
        throwDb(edgeError);
        const { data: record, error: recordError } = await db.from('custom_object_record')
          .select('id')
          .eq('tenant_id', tenantId).eq('id', recordId)
          .eq('custom_object_id', saved.customObjectId).is('archived_at', null)
          .maybeSingle();
        throwDb(recordError);
        if (!edge || !record) throw new FormRelationshipError(400, 'Invalid relationship selection');
      }
      cache.set(validatedSelectionKey, true);
    }
  }

  return { loadForm, eligibleDefinitions, relationshipOptions, validateSubmission };
}