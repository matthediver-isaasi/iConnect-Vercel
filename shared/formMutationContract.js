export const FORM_MUTATION_ACCESS_POLICY_VERSION = 1;
export const FORM_MUTATION_ACCESS_MODES = Object.freeze({
  APPLICANT_CONTINUATION: 'applicant_continuation',
  AUTHENTICATED_OWNER: 'authenticated_owner',
});

export const FORM_RECORD_ACCESS = Object.freeze({
  NONE: 'none',
  REFERENCE_ONLY: 'reference_only',
  CREATE_ONLY: 'create_only',
  MAY_MUTATE_EXISTING: 'may_mutate_existing',
});

export const FORM_MUTATION_CONFIG_KEYS = Object.freeze([
  'require_authentication',
  'mutation_access_policy',
  'fields',
  'field_mappings',
  'application_level',
  'auto_create_entity',
  'create_entity_type',
  'entity_action',
  'member_entity_action',
  'organization_entity_action',
  'additional_member_creations',
  'entity_pipelines',
  'structured_actions',
]);

const RANK = {
  [FORM_RECORD_ACCESS.NONE]: 0,
  [FORM_RECORD_ACCESS.REFERENCE_ONLY]: 1,
  [FORM_RECORD_ACCESS.CREATE_ONLY]: 2,
  [FORM_RECORD_ACCESS.MAY_MUTATE_EXISTING]: 3,
};

const entityKey = value => (
  value === 'organisation' ? 'organization' : value
);

const ORGANIZATION_DROPDOWN_TYPES = new Set([
  'organisation_dropdown',
  'organization_dropdown',
]);
const MEMBER_DROPDOWN_TYPES = new Set(['member_dropdown']);

const structuredActions = form => (
  Array.isArray(form?.structured_actions)
    ? form.structured_actions
    : Array.isArray(form?.structured_actions?.actions)
      ? form.structured_actions.actions
      : []
);

function mappingsForEntity(form, entity, pipeline = null) {
  const pipelineMappings = Array.isArray(pipeline?.mappings)
    ? pipeline.mappings
    : [];
  const topLevelMappings = (Array.isArray(form?.field_mappings) ? form.field_mappings : [])
    .filter(mapping => entityKey(mapping?.target_entity) === entity);
  return [...pipelineMappings, ...topLevelMappings];
}

function organizationMappingAccess(form, mappings) {
  if (!mappings.length) return FORM_RECORD_ACCESS.REFERENCE_ONLY;
  const fields = new Map((form?.fields || []).map(field => [String(field?.id), field]));
  let canCreate = false;
  for (const mapping of mappings) {
    const targetType = mapping?.target_type || 'core';
    const targetField = mapping?.target_field || mapping?.target_field_id;
    const sourceField = fields.get(String(mapping?.source_field_id || ''));
    const fromOrganizationDropdown = ORGANIZATION_DROPDOWN_TYPES.has(sourceField?.type);

    // Listed organisation dropdown values are target references. The processor
    // captures their IDs and deliberately skips assigning the UUID to any core
    // column. A mapped Not-listed name can create a new organisation.
    if (targetType === 'core' && fromOrganizationDropdown) {
      if (targetField === 'name'
        && sourceField?.not_listed_choice?.enabled === true
        && String(sourceField.not_listed_choice.label || '').trim()) {
        canCreate = true;
      }
      continue;
    }

    // Name is the upsert identity. On an existing match the processor removes
    // the unchanged name before deciding whether a write is necessary.
    if (targetType === 'core'
      && ['name', 'organization_name', 'organisation_name'].includes(targetField)) {
      canCreate = true;
      continue;
    }

    // Any companion core/custom mapping can alter the resolved organisation.
    return FORM_RECORD_ACCESS.MAY_MUTATE_EXISTING;
  }
  return canCreate ? FORM_RECORD_ACCESS.CREATE_ONLY : FORM_RECORD_ACCESS.REFERENCE_ONLY;
}

function memberMappingAccess(form, mappings, config = {}) {
  if (config?.role_id
    || typeof config?.login_enabled === 'boolean'
    || config?.role_assignment?.mode === 'answer_mapping') {
    return FORM_RECORD_ACCESS.MAY_MUTATE_EXISTING;
  }
  if (!mappings.length) return FORM_RECORD_ACCESS.REFERENCE_ONLY;
  const fields = new Map((form?.fields || []).map(field => [String(field?.id), field]));
  const onlySelectedMemberReferences = mappings.every(mapping => (
    (mapping?.target_type || 'core') === 'core'
    && MEMBER_DROPDOWN_TYPES.has(fields.get(String(mapping?.source_field_id || ''))?.type)
  ));
  return onlySelectedMemberReferences
    ? FORM_RECORD_ACCESS.REFERENCE_ONLY
    : FORM_RECORD_ACCESS.MAY_MUTATE_EXISTING;
}

function pipelineAccess(form, entity, pipeline) {
  if (pipeline?.field_mappings
    && typeof pipeline.field_mappings === 'object'
    && Object.keys(pipeline.field_mappings).length > 0) {
    return FORM_RECORD_ACCESS.MAY_MUTATE_EXISTING;
  }
  const mappings = mappingsForEntity(form, entity, pipeline);
  return entity === 'organization'
    ? organizationMappingAccess(form, mappings)
    : memberMappingAccess(form, mappings, pipeline);
}

function addEvidence(targets, entity, access, family, detail) {
  const key = entityKey(entity);
  if (!targets[key]) return;
  targets[key].evidence.push({ family, access, detail });
  if (RANK[access] > RANK[targets[key].classification]) {
    targets[key].classification = access;
  }
}

/**
 * Classifies persisted form configuration, not request data. In particular,
 * selecting an existing record is kept separate from changing that record.
 */
export function classifyFormMutationContract(form = {}) {
  const targets = {
    member: { classification: FORM_RECORD_ACCESS.NONE, evidence: [] },
    organization: { classification: FORM_RECORD_ACCESS.NONE, evidence: [] },
  };

  const pipelines = form.entity_pipelines;
  if (pipelines !== undefined && pipelines !== null) {
    for (const [entity, entries] of [
      ['member', pipelines?.members],
      ['organization', pipelines?.organisations || pipelines?.organizations],
    ]) {
      for (const entry of Array.isArray(entries) ? entries : []) {
        const access = pipelineAccess(form, entity, entry);
        addEvidence(
          targets,
          entity,
          access,
          'entity_pipelines',
          entry?.label || entry?.id || `${entity} pipeline`,
        );
      }
    }
  } else {
    const actionable = action => ['create', 'update', 'upsert'].includes(action);
    const legacyType = entityKey(form.create_entity_type);
    for (const entity of ['member', 'organization']) {
      const explicit = entity === 'member'
        ? form.member_entity_action
        : form.organization_entity_action;
      let action = actionable(explicit) ? explicit : null;
      if (!action
        && actionable(form.entity_action)
        && (legacyType === entity || legacyType === 'both')) {
        action = form.entity_action;
      }
      if (!action) continue;
      let access = action === 'create'
        ? FORM_RECORD_ACCESS.CREATE_ONLY
        : entity === 'organization'
          ? organizationMappingAccess(form, mappingsForEntity(form, entity))
          : memberMappingAccess(
            form,
            mappingsForEntity(form, entity),
            { role_id: form.default_member_role_id },
          );
      addEvidence(targets, entity, access, 'legacy_entity_action', `${entity}:${action}`);
    }
  }

  for (const entry of Array.isArray(form.additional_member_creations)
    ? form.additional_member_creations
    : []) {
    const access = pipelineAccess(form, 'member', entry);
    addEvidence(
      targets,
      'member',
      access,
      'additional_member_creations',
      entry?.label || entry?.id || 'additional member',
    );
  }

  const applicantContinuationUnsupportedReasons = [];
  for (const action of structuredActions(form)) {
    const entity = entityKey(action?.target?.kind || action?.entity_type || action?.entity);
    const operation = action?.operation;
    const detail = action?.label || action?.id || operation;
    if (['update', 'upsert', 'update_selected'].includes(operation)) {
      applicantContinuationUnsupportedReasons.push({
        family: 'structured_actions',
        operation,
        detail,
      });
    } else if (['resolve_record_reference', 'resolve_record_references'].includes(operation)
      && action?.not_listed_policy !== 'skip'
      && action?.not_listed_operation === 'upsert') {
      applicantContinuationUnsupportedReasons.push({
        family: 'structured_not_listed_upsert',
        operation: 'upsert',
        detail,
      });
    }
    if (!targets[entity]) continue;
    if (['update', 'upsert', 'update_selected'].includes(operation)) {
      addEvidence(
        targets,
        entity,
        FORM_RECORD_ACCESS.MAY_MUTATE_EXISTING,
        'structured_actions',
        detail,
      );
    } else if (operation === 'create') {
      addEvidence(targets, entity, FORM_RECORD_ACCESS.CREATE_ONLY, 'structured_actions', detail);
    } else if (['resolve_record_reference', 'resolve_record_references'].includes(operation)) {
      addEvidence(targets, entity, FORM_RECORD_ACCESS.REFERENCE_ONLY, 'structured_actions', detail);
      // Resolver contracts predate the explicit policy property; absence keeps
      // their established include behaviour, while explicit skip is reference-only.
      if (action?.not_listed_policy !== 'skip'
        && action?.not_listed_operation === 'upsert') {
        addEvidence(
          targets,
          entity,
          FORM_RECORD_ACCESS.MAY_MUTATE_EXISTING,
          'structured_not_listed_upsert',
          detail,
        );
      } else if (action?.not_listed_policy !== 'skip'
        && action?.not_listed_operation === 'create') {
        addEvidence(
          targets,
          entity,
          FORM_RECORD_ACCESS.CREATE_ONLY,
          'structured_not_listed_create',
          detail,
        );
      }
    }
  }

  const mutationTargets = Object.entries(targets)
    .filter(([, target]) => target.classification === FORM_RECORD_ACCESS.MAY_MUTATE_EXISTING)
    .map(([entity]) => entity);
  return {
    targets,
    mutationTargets,
    hasExistingRecordMutation: mutationTargets.length > 0,
    applicantContinuationUnsupportedReasons,
    hasUnsupportedApplicantContinuationMutation:
      applicantContinuationUnsupportedReasons.length > 0,
  };
}

export function validateMutationAccessPolicy(policy) {
  if (policy == null) return { ok: true, policy: null };
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)
    || policy.version !== FORM_MUTATION_ACCESS_POLICY_VERSION
    || !Object.values(FORM_MUTATION_ACCESS_MODES).includes(policy.mode)) {
    return {
      ok: false,
      code: 'INVALID_FORM_MUTATION_ACCESS_POLICY',
      error: 'Existing-record access must use a supported version and authority mode.',
    };
  }
  return {
    ok: true,
    policy: { version: FORM_MUTATION_ACCESS_POLICY_VERSION, mode: policy.mode },
  };
}

/**
 * Secure continuation links may be issued for legacy organisation-mutation
 * forms before an explicit policy is saved. This does not authorize a bare
 * public request: the submission processor must still verify a server-issued
 * continuation grant. Member writes are supported only as part of this
 * organisation-scoped flow and must be restricted to the grant's trusted
 * member snapshot.
 */
export function supportsApplicantContinuationIssuance(form = {}) {
  const classification = classifyFormMutationContract(form);
  const mode = form?.mutation_access_policy?.mode;
  return classification.mutationTargets.includes('organization')
    && !classification.hasUnsupportedApplicantContinuationMutation
    && (mode === FORM_MUTATION_ACCESS_MODES.APPLICANT_CONTINUATION
      || (form?.mutation_access_policy == null && form?.require_authentication !== true));
}

export function assessFormMutationAccess(form = {}) {
  const classification = classifyFormMutationContract(form);
  const policyValidation = validateMutationAccessPolicy(form.mutation_access_policy);
  if (!policyValidation.ok) return { ...classification, ...policyValidation };
  if (!classification.hasExistingRecordMutation) {
    return { ...classification, ok: true, policy: policyValidation.policy };
  }

  const mode = policyValidation.policy?.mode;
  if (mode === FORM_MUTATION_ACCESS_MODES.AUTHENTICATED_OWNER) {
    if (form.require_authentication === true) {
      return { ...classification, ok: true, policy: policyValidation.policy };
    }
    return {
      ...classification,
      ok: false,
      code: 'UNSAFE_EXISTING_RECORD_MUTATION_CONTRACT',
      error: 'Authenticated-owner updates require this form to require login.',
    };
  }
  if (mode === FORM_MUTATION_ACCESS_MODES.APPLICANT_CONTINUATION) {
    if (classification.hasUnsupportedApplicantContinuationMutation) {
      return {
        ...classification,
        ok: false,
        code: 'UNSAFE_EXISTING_RECORD_MUTATION_CONTRACT',
        error: 'Applicant continuation does not support Structured Record update, upsert, update-selected, or Not-listed upsert actions. Require login and choose authenticated-owner access, or remove those mutation actions.',
      };
    }
    if (classification.mutationTargets.includes('organization')) {
      return { ...classification, ok: true, policy: policyValidation.policy };
    }
    return {
      ...classification,
      ok: false,
      code: 'UNSAFE_EXISTING_RECORD_MUTATION_CONTRACT',
      error: 'Applicant continuation requires an organisation update flow. Member-only updates require authenticated-owner access.',
    };
  }

  if (classification.hasUnsupportedApplicantContinuationMutation) {
    return {
      ...classification,
      ok: false,
      code: 'UNSAFE_EXISTING_RECORD_MUTATION_CONTRACT',
      error: 'Structured Record update, upsert, update-selected, and Not-listed upsert actions require login and authenticated-owner access; applicant continuation cannot authorize these actions.',
    };
  }

  const memberOnlyMutation = classification.mutationTargets.length === 1
    && classification.mutationTargets[0] === 'member';
  return {
    ...classification,
    ok: false,
    code: 'UNSAFE_EXISTING_RECORD_MUTATION_CONTRACT',
    error: memberOnlyMutation && form.require_authentication !== true
      ? 'Public member pipelines resolve identity matches such as email as upserts, so they are not a create-only signup contract. Public collision-safe member creation is not currently supported: require login and choose authenticated-owner access. Existing-record updates will not be silently dropped.'
      : form.require_authentication
      ? 'Choose authenticated-owner access for existing member or organisation updates. Login alone does not authorize an arbitrary selected organisation.'
      : 'Public existing-organisation updates require server-verified applicant continuation. Reference-only selection does not require this access.',
  };
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value ?? null;
}

export function hasFormMutationConfigChanged(previous = {}, candidate = {}) {
  return FORM_MUTATION_CONFIG_KEYS.some(key => (
    JSON.stringify(canonical(previous[key])) !== JSON.stringify(canonical(candidate[key]))
  ));
}

/**
 * Save boundary used by both Form POST and PATCH handlers. Legacy active forms
 * are grandfathered only while their mutation configuration remains unchanged.
 */
export function validateFormMutationAccessSave({
  form,
  previousForm = null,
  isCreate = false,
} = {}) {
  const assessment = assessFormMutationAccess(form || {});
  if (assessment.code === 'INVALID_FORM_MUTATION_ACCESS_POLICY') return assessment;
  if (form?.is_active === false) {
    return assessment.ok
      ? assessment
      : { ...assessment, ok: true, draftWarning: assessment.error };
  }
  if (assessment.ok) return assessment;
  if (!assessment.hasExistingRecordMutation
    || assessment.code === 'INVALID_FORM_MUTATION_ACCESS_POLICY') {
    return assessment;
  }

  const legacyUnchanged = !isCreate
    && previousForm
    && previousForm.is_active !== false
    && previousForm.mutation_access_policy == null
    && form?.mutation_access_policy == null
    && !hasFormMutationConfigChanged(previousForm, form);
  if (legacyUnchanged) {
    return { ...assessment, ok: true, legacyCompatibility: true };
  }
  return assessment;
}