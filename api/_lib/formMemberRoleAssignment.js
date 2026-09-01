const ROLE_MAPPING_FIELD_TYPES = new Set(['select', 'radio']);
const ROLE_SENTINELS = new Set(['__keep__', '__clear__']);

const fieldType = (field) => String(field?.type || field?.field_type || '').toLowerCase();

export const formRoleFieldOptions = (field) => {
  if (!ROLE_MAPPING_FIELD_TYPES.has(fieldType(field))) return [];
  return (Array.isArray(field?.options) ? field.options : [])
    .map((option) => {
      if (option && typeof option === 'object') {
        const value = option.value ?? option.label;
        return value === undefined || value === null
          ? null
          : { value: String(value), label: String(option.label ?? value) };
      }
      return option === undefined || option === null
        ? null
        : { value: String(option), label: String(option) };
    })
    .filter((option) => option && option.value !== '');
};

export const isFormRoleMappingField = (field) => formRoleFieldOptions(field).length > 0;

export const hasAnswerDrivenMemberRoleAssignments = (entityPipelines) => (
  Array.isArray(entityPipelines?.members)
  && entityPipelines.members.some((pipeline) => pipeline?.role_assignment?.mode === 'from_field')
);

export const authorizeAnswerDrivenMemberRoleWrite = async ({
  entityPipelines,
  tenantCtx,
  hasAdminAccess,
  hasFeatureAccess,
}) => {
  if (!hasAnswerDrivenMemberRoleAssignments(entityPipelines)) return { ok: true };
  if (!tenantCtx?.isAuthenticated) {
    return { ok: false, status: 401, error: 'Authentication required' };
  }
  if (!tenantCtx.tenantId) {
    return { ok: false, status: 400, error: 'Tenant context required' };
  }
  if (tenantCtx.tenantUserId || await hasAdminAccess(tenantCtx)) return { ok: true };
  if (tenantCtx.roleId
      && await hasFeatureAccess(tenantCtx.roleId, 'admin.member-role-assignment')) {
    return { ok: true };
  }
  return {
    ok: false,
    status: 403,
    error: 'Member Role Assignment access required',
  };
};

const fallbackResult = (assignment) => {
  const fallback = assignment?.fallback || 'default';
  if (fallback === 'none') {
    return { configured: true, roleId: null, source: 'field-fallback-none' };
  }
  if (fallback === 'fixed') {
    return {
      configured: true,
      roleId: assignment?.fallback_role_id || undefined,
      source: 'field-fallback-fixed',
    };
  }
  return { configured: true, roleId: undefined, source: 'field-fallback-default' };
};

/**
 * Resolve a member pipeline's answer-driven role without ever accepting the
 * submitted answer as a role id. Only persisted value_to_role_id entries can
 * produce a role assignment.
 */
export const resolveMemberRoleAssignment = ({ pipeline, answers = {} }) => {
  const assignment = pipeline?.role_assignment;
  if (!assignment || assignment.mode !== 'from_field') {
    return { configured: false, roleId: undefined, source: 'fixed' };
  }

  const sourceFieldId = typeof assignment.source_field_id === 'string'
    ? assignment.source_field_id.trim()
    : '';
  if (!sourceFieldId) {
    return {
      configured: true,
      invalid: true,
      error: 'The member role mapping has no source form field.',
      code: 'INVALID_MEMBER_ROLE_MAPPING',
    };
  }

  const rawAnswer = answers?.[sourceFieldId];
  if (Array.isArray(rawAnswer) || (rawAnswer && typeof rawAnswer === 'object')) {
    return {
      configured: true,
      invalid: true,
      error: 'The member role mapping requires a single-choice answer.',
      code: 'INVALID_MEMBER_ROLE_ANSWER',
    };
  }
  if (rawAnswer === undefined || rawAnswer === null || rawAnswer === '') {
    return fallbackResult(assignment);
  }

  const answerKey = String(rawAnswer);
  const map = assignment.value_to_role_id;
  if (map && typeof map === 'object' && !Array.isArray(map)
      && Object.prototype.hasOwnProperty.call(map, answerKey)) {
    const mappedRoleId = map[answerKey];
    return {
      configured: true,
      roleId: mappedRoleId === null || mappedRoleId === '__clear__' ? null : mappedRoleId,
      source: 'field-mapped',
      answer: answerKey,
    };
  }

  return fallbackResult(assignment);
};

const fail = (error, details = undefined) => ({
  ok: false,
  error,
  code: 'INVALID_MEMBER_ROLE_ASSIGNMENT',
  details,
});

/**
 * Validate persisted member role configuration at the Form write boundary.
 * Role ids are checked in one tenant-scoped query; answer values must be real
 * options from the selected scalar choice field.
 */
export const validateFormMemberRoleAssignments = async ({
  supabase,
  tenantId,
  fields = [],
  entityPipelines,
}) => {
  const members = Array.isArray(entityPipelines?.members) ? entityPipelines.members : [];
  if (members.length === 0) return { ok: true };
  if (!tenantId) return fail('Tenant context is required to validate member roles.');

  const fieldsById = new Map((Array.isArray(fields) ? fields : [])
    .filter((field) => field?.id)
    .map((field) => [String(field.id), field]));
  const roleIds = new Set();

  for (let index = 0; index < members.length; index += 1) {
    const pipeline = members[index] || {};
    const label = pipeline.label || `Member ${index + 1}`;
    if (pipeline.role_id && !ROLE_SENTINELS.has(pipeline.role_id)) {
      roleIds.add(String(pipeline.role_id));
    }

    const assignment = pipeline.role_assignment;
    if (!assignment) continue;
    if (!['fixed', 'from_field'].includes(assignment.mode)) {
      return fail(`${label} has an invalid role assignment mode.`, { pipeline_index: index });
    }
    if (assignment.mode === 'fixed') continue;

    const sourceFieldId = typeof assignment.source_field_id === 'string'
      ? assignment.source_field_id.trim()
      : '';
    const sourceField = fieldsById.get(sourceFieldId);
    if (!sourceField || !isFormRoleMappingField(sourceField)) {
      return fail(`${label} must use a dropdown or radio field with at least one option for role assignment.`, {
        pipeline_index: index,
        source_field_id: sourceFieldId || null,
      });
    }

    const valueMap = assignment.value_to_role_id;
    if (!valueMap || typeof valueMap !== 'object' || Array.isArray(valueMap)) {
      return fail(`${label} has an invalid answer-to-role mapping.`, { pipeline_index: index });
    }
    const allowedValues = new Set(formRoleFieldOptions(sourceField).map((option) => option.value));
    for (const [answer, roleId] of Object.entries(valueMap)) {
      if (!allowedValues.has(String(answer))) {
        return fail(`${label} maps an answer that is no longer available on the selected field.`, {
          pipeline_index: index,
          answer,
        });
      }
      if (roleId !== null && roleId !== '__clear__') {
        if (typeof roleId !== 'string' || !roleId.trim() || ROLE_SENTINELS.has(roleId)) {
          return fail(`${label} has an invalid mapped role.`, { pipeline_index: index, answer });
        }
        roleIds.add(roleId);
      }
    }

    const fallback = assignment.fallback || 'default';
    if (!['default', 'none', 'fixed'].includes(fallback)) {
      return fail(`${label} has an invalid unmapped-answer fallback.`, { pipeline_index: index });
    }
    if (fallback === 'fixed') {
      if (typeof assignment.fallback_role_id !== 'string' || !assignment.fallback_role_id.trim()) {
        return fail(`${label} must select a fallback role.`, { pipeline_index: index });
      }
      roleIds.add(assignment.fallback_role_id);
    }
  }

  if (roleIds.size === 0) return { ok: true };
  const requestedRoleIds = [...roleIds];
  const { data: roles, error } = await supabase
    .from('role')
    .select('id')
    .eq('tenant_id', tenantId)
    .in('id', requestedRoleIds);
  if (error) throw error;
  const validRoleIds = new Set((roles || []).map((role) => String(role.id)));
  const invalidRoleIds = requestedRoleIds.filter((roleId) => !validRoleIds.has(String(roleId)));
  if (invalidRoleIds.length > 0) {
    return fail('One or more configured member roles do not belong to this tenant.', {
      invalid_role_ids: invalidRoleIds,
    });
  }

  return { ok: true };
};