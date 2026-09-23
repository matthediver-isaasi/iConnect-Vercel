import { FormApplicantContinuationError } from './formApplicantContinuation.js';
import { coalesceExplicitFallbackMappings, partitionIgnoredHiddenMappings, extractMappingSourceComponent } from './formMappingFallbacks.js';
import { resolveStaticTodayToken } from './staticValueTokens.js';
import { resolveFormEntityActions, hasPersistedLegacyFormEntityActions } from './formEntityActionMode.js';

export function transformApplicantIdentity(value, transformation) {
  if (value === null || value === undefined) return value;
  const text = String(value);
  switch (transformation) {
    case 'trim': return text.trim();
    case 'uppercase': return text.toUpperCase();
    case 'lowercase': return text.toLowerCase();
    case 'titlecase': return text.replace(/\w\S*/g, word => word.charAt(0).toUpperCase() + word.substr(1).toLowerCase());
    case 'extract_domain': {
      let domain = text.trim();
      if (domain.includes('@')) domain = domain.split('@').pop() || domain;
      return domain.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '')
        .replace(/^www\./i, '').split(/[/?#]/)[0].toLowerCase() || text;
    }
    case 'extract_username': return text.includes('@') ? text.split('@')[0] || text : text;
    case 'first_word': return text.trim().split(/\s+/)[0] || text;
    case 'last_word': return text.trim().split(/\s+/).at(-1) || text;
    case 'remove_spaces': return text.replace(/\s+/g, '');
    case 'numbers_only': return text.replace(/[^0-9]/g, '');
    case 'current_date': return new Date().toISOString().split('T')[0];
    default: return text;
  }
}

// The legacy writer resolves one primary member, then each additional member.
// Resolve those identities, not all source values: a superseded email is not a
// mutation target, and a dropdown used only as a relationship reference is not
// a request to edit its selected member.
export function resolveApplicantLegacyIdentityPlan({
  form, values, hiddenFieldIds = new Set(), primaryMemberId = null,
  applyTransformation = transformApplicantIdentity,
}) {
  const empty = value => value === undefined || value === null || value === '';
  const fields = new Map((form.fields || []).map(field => [String(field.id), field]));
  const entityPipelines = hasPersistedLegacyFormEntityActions(form)
    ? form.entity_pipelines : { members: [], organisations: [] };
  const pipelines = entityPipelines?.members || [];
  const primary = pipelines.find(pipeline => pipeline.isPrimary || pipeline.is_primary);
  const owned = new Set((primary?.mappings || [])
    .filter(mapping => mapping.target_type === 'core' && mapping.target_field)
    .map(mapping => mapping.target_field));
  const effective = mappings => coalesceExplicitFallbackMappings(
    partitionIgnoredHiddenMappings(mappings || [], hiddenFieldIds).includedMappings,
    values, hiddenFieldIds,
  );
  const sourceValue = (mapping, phase) => {
    if (mapping.source_type === 'clear') return '__clear__';
    if (phase === 'top' && (mapping.source_type === 'current_date' || mapping.transformation === 'current_date')) {
      return applyTransformation('', 'current_date');
    }
    let value;
    if (mapping.source_type === 'static') {
      value = resolveStaticTodayToken(mapping.static_value);
      if (phase === 'top') return value; // top-level static mappings do not transform
    } else if (phase === 'pipeline' && mapping.transformation === 'current_date') {
      value = applyTransformation('', 'current_date');
    } else {
      if (!mapping.source_field_id) return undefined;
      value = extractMappingSourceComponent(mapping, values[mapping.source_field_id]);
      if (mapping.source_category_id && value && typeof value === 'object' && !Array.isArray(value)) {
        value = value[mapping.source_category_id] ?? null;
      }
      // Top-level mappings skip empty input before applying transformations.
      if (phase === 'top' && empty(value)) return undefined;
    }
    if (value === '__clear__') return value;
    return value != null && mapping.transformation && mapping.transformation !== 'none'
      ? applyTransformation(value, mapping.transformation) : value;
  };
  let email;
  let dropdownId = null;
  function assign(mapping, phase, captureDropdown = true) {
    if (mapping.target_type !== 'core' || !mapping.target_field) return;
    const value = phase === 'implicit' || phase === 'legacy'
      ? (mapping.source_field_id === '__clear__' ? '__clear__' : values[mapping.source_field_id])
      : sourceValue(mapping, phase);
    if (value === '__clear__' && phase !== 'implicit') {
      if (mapping.target_field === 'email') email = null;
      return;
    }
    // organization_group_id is handled as a relationship selection before
    // the writer's member-dropdown identity capture branch.
    if (mapping.target_field === 'organization_group_id') return;
    if (captureDropdown && fields.get(String(mapping.source_field_id))?.type === 'member_dropdown') {
      if (typeof value === 'string' && value && !dropdownId) dropdownId = value;
      return;
    }
    if (mapping.target_field === 'email' && !empty(value)) email = value;
  }
  if (Array.isArray(form.field_mappings) && form.field_mappings.length) {
    for (const mapping of effective(form.field_mappings)) {
      if (mapping.target_entity === 'member' && !owned.has(mapping.target_field)) assign(mapping, 'top');
    }
  } else {
    // Implicit core bindings are the fallback only when the top-level mapping
    // array is absent/empty. Their hidden behavior is intentionally not the
    // explicit mappings' opt-in ignore_if_hidden behavior.
    for (const field of fields.values()) {
      const [entity, target] = (field.core_field_mapping || '').split('.');
      if (entity === 'member' && !owned.has(target)) {
        assign({ target_type: 'core', target_field: target, source_field_id: field.id }, 'implicit');
      }
    }
  }
  if (Array.isArray(primary?.mappings) && primary.mappings.length) {
    for (const mapping of effective(primary.mappings)) assign(mapping, 'pipeline');
  } else if (primary && !primary.mappings && primary.field_mappings?.email) {
    // The primary legacy-object executor does not perform dropdown capture.
    assign({ target_type: 'core', target_field: 'email', source_field_id: primary.field_mappings.email }, 'legacy', false);
  }
  const { memberAction } = resolveFormEntityActions({
    entityPipelines, memberEntityAction: form.member_entity_action,
    organizationEntityAction: form.organization_entity_action, createEntityType: form.create_entity_type,
    applicationLevel: form.application_level, entityAction: form.entity_action,
  });
  const checks = [];
  const add = (column, value, trim = false) => {
    if (empty(value)) return;
    if (typeof value !== 'string') throw new FormApplicantContinuationError('Applicant target identity must be a scalar value.');
    checks.push({ entity: 'member', column, value: trim ? value.toLowerCase().trim() : value });
  };
  if (memberAction !== 'none') {
    const id = primaryMemberId || dropdownId;
    if (id) add('id', id);
    else if (email) add('email', email);
  }
  // Modern member pipelines replace, rather than supplement, the legacy
  // additional-member list. Additional lookup uses the FIRST effective email
  // mapping, even though later mappings may update the resulting payload.
  const additional = pipelines.length
    ? pipelines.filter(pipeline => !pipeline.isPrimary && !pipeline.is_primary)
    : form.additional_member_creations || [];
  for (const pipeline of additional) {
    let value;
    if (Array.isArray(pipeline.mappings)) {
      const mapping = effective(pipeline.mappings).find(item => item.target_type === 'core' && item.target_field === 'email');
      if (!mapping || mapping.source_type === 'clear') continue;
      if (mapping.source_type === 'static') value = mapping.static_value;
      else if (mapping.source_type === 'current_date' || mapping.transformation === 'current_date') {
        value = applyTransformation('', 'current_date');
      } else if (mapping.source_field_id) {
        // Additional identity extraction does not apply source_category_id.
        value = extractMappingSourceComponent(mapping, values[mapping.source_field_id]);
        if (mapping.transformation && mapping.transformation !== 'none') value = applyTransformation(value, mapping.transformation);
      }
    } else if (pipeline.field_mappings?.email && pipeline.field_mappings.email !== '__clear__') {
      value = values[pipeline.field_mappings.email];
    }
    if (value) add('email', value, true);
  }
  return checks;
}

// Read-only authorization preflight. It deliberately runs before the structured
// executor and legacy organization writes: denied contact targets must not leave
// an otherwise authorized organization half-updated.
export async function preflightApplicantTargets({
  db, form, grant, values, hiddenFieldIds = new Set(), memberIds = [],
  applyTransformation = transformApplicantIdentity, createdMemberIds = [], primaryMemberId = null,
}) {
  const allowedMembers = new Set([...memberIds, ...createdMemberIds].map(String));
  const checks = resolveApplicantLegacyIdentityPlan({ form, values, hiddenFieldIds, primaryMemberId, applyTransformation });
  // The processor installs the grant's organization as its explicit prefill,
  // which wins over dropdowns, member organization and mapped name lookups.
  // A mapped name therefore updates this organization; it is not another target.
  checks.push({ entity: 'organization', column: 'id', value: grant.organization_id });
  const actions = Array.isArray(form.structured_actions) ? form.structured_actions : form.structured_actions?.actions || [];
  for (const action of actions) {
    // Dynamic selectors/row-scoped target resolvers require their own complete
    // preflight; do not execute them and discover an authorization error later.
    if (['update', 'upsert', 'update_selected'].includes(action.operation)
      || action.not_listed_operation === 'upsert') {
      throw new FormApplicantContinuationError('Applicant continuation does not yet support this structured mutation selector. Use authenticated-owner access.');
    }
  }
  for (const check of checks) {
    let query = db.from(check.entity).select('id').eq('tenant_id', form.tenant_id);
    query = check.column === 'id' ? query.eq('id', check.value) : query.ilike(check.column, check.value);
    const { data, error } = await query.limit(1);
    if (error) throw error;
    if (check.column === 'id' && !data?.length) {
      throw new FormApplicantContinuationError(`The selected ${check.entity} is unavailable in this tenant.`);
    }
    for (const row of data || []) {
      const allowed = check.entity === 'organization'
        ? String(row.id) === String(grant.organization_id) : allowedMembers.has(String(row.id));
      if (!allowed) throw new FormApplicantContinuationError(`The selected ${check.entity} is outside this applicant link's scope.`);
    }
  }
}