/**
 * Trusted integration boundary for BNMS Department current-set forms.
 *
 * Browser code may use only `loadDepartmentCurrentSet`.  Submission processing
 * calls `reconcileDepartmentCurrentSet` with a durable form_submission id; the
 * database function owns all mutation, authorization rechecks and idempotency.
 */
import { getSession, getSessionMember } from './session.js';
import { resolveFormAccess } from './formAccessPolicy.js';
import { computeAuthoritativeHiddenFieldIds } from './formFieldVisibility.js';
import { validateRepeatableRowSubmission } from './formRepeatableRowValidation.js';
import { departmentCurrentSetValidationOptions } from './departmentCurrentSetValidation.js';
import { isFormScheduleAvailable } from './formAvailability.js';
import {
  assertDepartmentCurrentSetCompatibility,
  assertDepartmentCurrentSetLoadedBounds,
} from './departmentCurrentSetCompatibility.js';

export const DEPARTMENT_CURRENT_SET_METADATA_KEY = '__department_current_set';
export const DEPARTMENT_CURRENT_SET_FORM_ID = '8b6f44d3-83f8-449e-9496-b10b1dc28e5f';
export const DEPARTMENT_CURRENT_SET_TENANT_ID = 'ff2df806-b321-4254-b651-3af11fccf1db';

export class DepartmentCurrentSetError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const uuid = value => typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

export function currentSetMetadata({ departmentId, version, completeSections }) {
  return {
    [DEPARTMENT_CURRENT_SET_METADATA_KEY]: {
      department_id: departmentId,
      version,
      complete_sections: completeSections,
    },
  };
}

export function assertCurrentSetFormValues({ values, configuration }) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    throw new DepartmentCurrentSetError(400, 'CURRENT_SET_INVALID', 'Current-set answers must be an object');
  }
  const meta = values[DEPARTMENT_CURRENT_SET_METADATA_KEY];
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)
    || !uuid(meta.department_id) || typeof meta.version !== 'string'
    || !Array.isArray(meta.complete_sections)) {
    throw new DepartmentCurrentSetError(400, 'CURRENT_SET_INCOMPLETE', 'Current-set prefill metadata is missing or invalid');
  }
  const expected = [configuration.workforce_container_field_id, configuration.equipment_container_field_id];
  if (!expected.every(id => meta.complete_sections.includes(id))) {
    throw new DepartmentCurrentSetError(400, 'CURRENT_SET_INCOMPLETE', 'Both current-set sections must be completely loaded before saving');
  }
  for (const id of expected) {
    if (!Array.isArray(values[id])) {
      throw new DepartmentCurrentSetError(400, 'CURRENT_SET_INCOMPLETE', 'Both current-set sections must be submitted as complete arrays');
    }
  }
  return {
    departmentId: meta.department_id,
    version: meta.version,
    workforce: values[configuration.workforce_container_field_id],
    equipment: values[configuration.equipment_container_field_id],
  };
}

export function rpcError(error) {
  const message = error?.message || 'Current department data could not be saved';
  if (error?.code === '40001' || error?.code === '40P01') {
    return new DepartmentCurrentSetError(409, 'CURRENT_SET_CONFLICT',
      'Current department data changed; reload and review it before saving');
  }
  if (/CURRENT_SET_(?:CONFLICT|AUTHORIZATION|INCOMPLETE|INVALID|AMBIGUOUS)/.test(message)) {
    const code = message.match(/CURRENT_SET_[A-Z_]+/)?.[0] || 'CURRENT_SET_FAILED';
    return new DepartmentCurrentSetError(code === 'CURRENT_SET_CONFLICT' ? 409 : 403, code, message);
  }
  return new DepartmentCurrentSetError(503, 'CURRENT_SET_UNAVAILABLE', message);
}

async function trustedMember({ req, tenantId, getMember = getSessionMember }) {
  const member = await getMember(req);
  const memberTenantId = member?.tenant_id || member?.organization?.tenant_id || null;
  if (!member?.id || memberTenantId !== tenantId) {
    throw new DepartmentCurrentSetError(401, 'CURRENT_SET_AUTHENTICATION_REQUIRED', 'A signed-in member is required');
  }
  return member;
}

export async function loadDepartmentCurrentSet({
  db, req, tenantId, formId, departmentId, getMember, getActiveSession = getSession,
}) {
  if (tenantId !== DEPARTMENT_CURRENT_SET_TENANT_ID || formId !== DEPARTMENT_CURRENT_SET_FORM_ID) {
    throw new DepartmentCurrentSetError(404, 'CURRENT_SET_NOT_CONFIGURED', 'Current department data is unavailable');
  }
  if (!uuid(formId) || !uuid(departmentId)) {
    throw new DepartmentCurrentSetError(400, 'CURRENT_SET_INVALID', 'A form and Department ID are required');
  }
  const member = await trustedMember({ req, tenantId, getMember });
  const session = await getActiveSession(req);
  if (!session?.id || session?.data?.memberId !== member.id) {
    throw new DepartmentCurrentSetError(401, 'CURRENT_SET_AUTHENTICATION_REQUIRED', 'Your signed-in session is no longer valid');
  }
  const [{ data: config, error: configError }, { data: form, error: formError }] = await Promise.all([
    db.from('department_current_set_config').select('config').eq('tenant_id', tenantId).eq('form_id', formId).maybeSingle(),
    db.from('form').select('id, tenant_id, is_active, require_authentication, access_policy, fields, pages, visibility_rules, deactivate_at, deactivate_timezone')
      .eq('id', formId).eq('tenant_id', tenantId).eq('is_active', true).maybeSingle(),
  ]);
  if (configError || !config?.config || formError || !form || !isFormScheduleAvailable(form)) throw new DepartmentCurrentSetError(404, 'CURRENT_SET_NOT_CONFIGURED', 'Current department data is unavailable');
  const access = await resolveFormAccess({
    supabase: db, req, tenantId, policy: form.access_policy, member, session,
  });
  if (!access.allowed || !form.require_authentication) {
    throw new DepartmentCurrentSetError(403, 'CURRENT_SET_AUTHORIZATION', 'You do not have access to this Department');
  }
  let compatibility;
  try {
    compatibility = assertDepartmentCurrentSetCompatibility({ form, configuration: config.config });
  } catch (error) {
    throw new DepartmentCurrentSetError(503, 'CURRENT_SET_CONFIGURATION_INVALID',
      error?.message || 'Current Department form configuration is unavailable');
  }
  const { data, error } = await db.rpc('department_current_set_load_authenticated', {
    p_tenant_id: tenantId, p_form_id: formId, p_department_id: departmentId, p_member_id: member.id,
    p_session_id: session.id,
  });
  if (error) throw rpcError(error);
  try {
    assertDepartmentCurrentSetLoadedBounds({
      loaded: data,
      configuration: config.config,
      contract: compatibility,
    });
  } catch (error) {
    throw new DepartmentCurrentSetError(409, 'CURRENT_SET_CONFLICT',
      error?.message || 'Current Department data cannot be safely loaded');
  }
  return data;
}

/**
 * Return the Departments that the signed-in member may choose for the
 * current-set form.  The form URL still accepts an explicit department_id
 * (links are useful for a member with one Department), but a respondent with
 * more than one assignment must not be forced to guess or hand-edit a UUID.
 *
 * This is intentionally a read-only graph projection.  It does not expose
 * current-set rows and it applies tenant, respondent-edge and active-record
 * checks before returning an option.  A signed-in respondent's explicit
 * assignment is sufficient even when the Department belongs to another
 * organisation in the same tenant.
 */
export async function listDepartmentCurrentSetOptions({
  db, req, tenantId, formId, getMember, getActiveSession = getSession,
}) {
  if (tenantId !== DEPARTMENT_CURRENT_SET_TENANT_ID || formId !== DEPARTMENT_CURRENT_SET_FORM_ID) {
    throw new DepartmentCurrentSetError(404, 'CURRENT_SET_NOT_CONFIGURED', 'Current department data is unavailable');
  }
  if (!uuid(formId)) {
    throw new DepartmentCurrentSetError(400, 'CURRENT_SET_INVALID', 'A form ID is required');
  }
  const member = await trustedMember({ req, tenantId, getMember });
  const session = await getActiveSession(req);
  if (!session?.id || session?.data?.memberId !== member.id) {
    throw new DepartmentCurrentSetError(401, 'CURRENT_SET_AUTHENTICATION_REQUIRED', 'Your signed-in session is no longer valid');
  }
  const [{ data: config, error: configError }, { data: form, error: formError }] = await Promise.all([
    db.from('department_current_set_config').select('config').eq('tenant_id', tenantId).eq('form_id', formId).maybeSingle(),
    db.from('form').select('id, tenant_id, is_active, require_authentication, access_policy, deactivate_at, deactivate_timezone')
      .eq('id', formId).eq('tenant_id', tenantId).eq('is_active', true).maybeSingle(),
  ]);
  if (configError || !config?.config || formError || !form || !form.require_authentication
      || !isFormScheduleAvailable(form)) {
    throw new DepartmentCurrentSetError(404, 'CURRENT_SET_NOT_CONFIGURED', 'Current department data is unavailable');
  }
  const access = await resolveFormAccess({
    supabase: db, req, tenantId, policy: form.access_policy, member, session,
  });
  if (!access.allowed) {
    throw new DepartmentCurrentSetError(403, 'CURRENT_SET_AUTHORIZATION', 'You do not have access to this Department');
  }

  const configuration = config.config;
  const respondentRelationshipId = configuration.respondent_relationship_id;
  const respondentFieldKey = configuration.respondent_field_key;
  const departmentObjectId = configuration.department_object_id;
  if (!uuid(respondentRelationshipId) || typeof respondentFieldKey !== 'string'
      || !respondentFieldKey || !uuid(departmentObjectId)) {
    throw new DepartmentCurrentSetError(503, 'CURRENT_SET_CONFIGURATION_INVALID',
      'Current Department respondent configuration is unavailable');
  }

  const [
    { data: respondentEdges, error: respondentError },
    { data: respondentDefinition, error: respondentDefinitionError },
    { data: departmentDefinition, error: definitionError },
  ] = await Promise.all([
    db.from('custom_object_relationship').select('source_record_id, target_record_id, field_values')
      .eq('tenant_id', tenantId).eq('relationship_definition_id', respondentRelationshipId)
      .eq('target_record_id', member.id).is('archived_at', null),
    db.from('custom_object_relationship_definition')
      .select('id, source_kind, source_custom_object_id, target_kind, target_custom_object_id, status')
      .eq('tenant_id', tenantId).eq('id', respondentRelationshipId).maybeSingle(),
    db.from('custom_object_definition').select('id, primary_display_field_id')
      .eq('tenant_id', tenantId).eq('id', departmentObjectId).eq('status', 'active').maybeSingle(),
  ]);
  if (respondentError || respondentDefinitionError || definitionError || !departmentDefinition
      || !respondentDefinition || respondentDefinition.status !== 'active'
      || respondentDefinition.source_kind !== 'custom_object'
      || respondentDefinition.source_custom_object_id !== departmentObjectId
      || respondentDefinition.target_kind !== 'member'
      || respondentDefinition.target_custom_object_id !== null) {
    throw new DepartmentCurrentSetError(503, 'CURRENT_SET_UNAVAILABLE', 'Assigned Departments could not be loaded');
  }
  const assignedIds = [...new Set((respondentEdges || [])
    .filter(edge => edge?.field_values?.[respondentFieldKey] === true)
    .map(edge => edge.source_record_id)
    .filter(uuid))];
  if (!assignedIds.length) return [];
  const { data: records, error: recordError } = await db
    .from('custom_object_record').select('id, data')
    .eq('tenant_id', tenantId).eq('custom_object_id', departmentObjectId)
    .is('archived_at', null).in('id', assignedIds);
  if (recordError) {
    throw new DepartmentCurrentSetError(503, 'CURRENT_SET_UNAVAILABLE', 'Assigned Departments could not be loaded');
  }
  const fieldName = departmentDefinition.primary_display_field_id
    ? (await db.from('preference_field').select('name').eq('tenant_id', tenantId)
      .eq('id', departmentDefinition.primary_display_field_id).maybeSingle()).data?.name
    : null;
  const recordsById = new Map((records || []).map(record => [record.id, record]));
  return assignedIds.filter(id => recordsById.has(id)).map(id => {
    const data = recordsById.get(id)?.data || {};
    return {
      id,
      label: String(data?.[fieldName] ?? data.department_name ?? data.name ?? id),
      organization_id: member.organization_id,
    };
  }).sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
}

/**
 * Lifecycle-only helper. `submissionId` must already be durably persisted;
 * callers must never pass a browser idempotency token to this function.
 */
export async function reconcileDepartmentCurrentSet({
  db, req, tenantId, formId, submissionId, values, getMember, getActiveSession = getSession,
}) {
  if (tenantId !== DEPARTMENT_CURRENT_SET_TENANT_ID || formId !== DEPARTMENT_CURRENT_SET_FORM_ID) {
    throw new DepartmentCurrentSetError(403, 'CURRENT_SET_AUTHORIZATION', 'Current department data is unavailable');
  }
  if (!uuid(submissionId)) {
    throw new DepartmentCurrentSetError(500, 'CURRENT_SET_SUBMISSION_REQUIRED', 'A durable submission is required');
  }
  const member = await trustedMember({ req, tenantId, getMember });
  const session = await getActiveSession(req);
  if (!session?.id || session?.data?.memberId !== member.id) {
    throw new DepartmentCurrentSetError(401, 'CURRENT_SET_AUTHENTICATION_REQUIRED', 'Your signed-in session is no longer valid');
  }
  const [{ data: config, error: configError }, { data: form, error: formError }] = await Promise.all([
    db.from('department_current_set_config').select('config').eq('tenant_id', tenantId).eq('form_id', formId).maybeSingle(),
    db.from('form').select('id, require_authentication, access_policy, is_active, fields, pages, visibility_rules, deactivate_at, deactivate_timezone')
      .eq('id', formId).eq('tenant_id', tenantId).eq('is_active', true).maybeSingle(),
  ]);
  if (configError || !config?.config || formError || !form || !form.require_authentication || !isFormScheduleAvailable(form)) {
    throw new DepartmentCurrentSetError(403, 'CURRENT_SET_AUTHORIZATION', 'Current department data is unavailable');
  }
  const access = await resolveFormAccess({
    supabase: db, req, tenantId, policy: form.access_policy, member, session,
  });
  if (!access.allowed) {
    throw new DepartmentCurrentSetError(403, 'CURRENT_SET_AUTHORIZATION', 'You do not have access to this Department');
  }
  try {
    assertDepartmentCurrentSetCompatibility({ form, configuration: config.config });
  } catch (error) {
    throw new DepartmentCurrentSetError(503, 'CURRENT_SET_CONFIGURATION_INVALID',
      error?.message || 'Current Department form configuration is unavailable');
  }
  const parsed = assertCurrentSetFormValues({ values, configuration: config.config });
  const { data: priorCommit, error: commitError } = await db.from('department_current_set_commit')
    .select('submission_id').eq('tenant_id', tenantId).eq('form_id', formId)
    .eq('submission_id', submissionId).maybeSingle();
  if (commitError) {
    throw new DepartmentCurrentSetError(503, 'CURRENT_SET_UNAVAILABLE', 'Current department retry status could not be verified');
  }
  // A durable replay is authenticated by the database wrapper and its stored
  // digest; do not reject it merely because its historical baseline has since
  // changed. A first attempt must validate against a fresh authorized load.
  if (!priorCommit) {
    const loaded = await loadDepartmentCurrentSet({
      db, req, tenantId, formId, departmentId: parsed.departmentId, getMember,
      getActiveSession,
    });
    if (loaded?.version !== parsed.version) {
      throw new DepartmentCurrentSetError(409, 'CURRENT_SET_CONFLICT', 'Current department data changed; reload and review it before saving');
    }
    let hiddenFieldIds;
    try {
      hiddenFieldIds = await computeAuthoritativeHiddenFieldIds({
        db, tenantId, form, formValues: values,
      });
      const protectedSections = [
        config.config.workforce_container_field_id,
        config.config.equipment_container_field_id,
      ];
      if (protectedSections.some(id => hiddenFieldIds.has(String(id)))) {
        throw new Error('Current Department sections must be visible before they can be saved');
      }
      await validateRepeatableRowSubmission({
        db, tenantId, form, submissionData: values, hiddenFieldIds,
        ...departmentCurrentSetValidationOptions(config.config, loaded),
      });
    } catch (error) {
      if (error instanceof DepartmentCurrentSetError) throw error;
      throw new DepartmentCurrentSetError(400, 'CURRENT_SET_INVALID', error?.message || 'Current Department answers are invalid');
    }
  }
  const { data, error } = await db.rpc('department_current_set_reconcile_authenticated', {
    p_tenant_id: tenantId,
    p_form_id: formId,
    p_department_id: parsed.departmentId,
    p_member_id: member.id,
    p_submission_id: submissionId,
    p_expected_version: parsed.version,
    p_session_id: session.id,
    p_validated_values: values,
  });
  if (error) throw rpcError(error);
  return data;
}