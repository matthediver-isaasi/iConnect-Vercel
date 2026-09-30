import { createClient } from '@supabase/supabase-js';
import { resolveTenantFromRequest } from '../../_lib/tenantResolver.js';
import { getSessionMember } from '../../_lib/session.js';
import { getTenantContext, hasAdminAccess } from '../../_lib/tenantContext.js';
import { resolveFormAccess, sendFormAccessDenied } from '../../_lib/formAccessPolicy.js';
import { isFormScheduleAvailable } from '../../_lib/formAvailability.js';
import {
  authorizeApplicantAdmission,
  loadApplicantMemberScope,
  FormApplicantContinuationError,
} from '../../_lib/formApplicantContinuation.js';
import { createLegacyApplicationScope } from '../../_lib/formLegacyApplication.js';
import { filterCommunicationCategoriesForMember } from '../../../shared/communicationCategoryMembership.js';
import { normalizeRepeatableRowField, isRepeatableRowField } from '../../../shared/formRepeatableRows.js';
import { attachCommunicationCategoryRoleIds } from '../communication-categories.js';
import { resolveMemberRoleAssignment } from '../../_lib/formMemberRoleAssignment.js';
import { derivePersistedFormRole } from '../../_lib/formProcessingPolicy.js';
import { rulesUseLmicOperators } from '../../_lib/formLmicConditions.js';
import { loadTenantLmicCodes } from '../../_lib/tenantLmicCodes.js';

export async function resolveCreationCommunicationMember({ db, form, sourceAnswers = {} }) {
  const pipelines = form.entity_pipelines?.members;
  const primary = Array.isArray(pipelines)
    ? pipelines.find(pipeline => pipeline?.isPrimary || pipeline?.is_primary) : null;
  if (!primary) return null;
  // Only persisted fields can supply answers. Request roles and pipeline
  // configuration are never read, and mapping values are not themselves roles.
  const answers = Object.fromEntries((form.fields || [])
    .filter(field => Object.hasOwn(sourceAnswers, field.id))
    .map(field => [field.id, sourceAnswers[field.id]]));
  const assignment = resolveMemberRoleAssignment({ pipeline: primary, answers });
  if (assignment.invalid) {
    throw Object.assign(new Error(assignment.error), { status: 400, code: assignment.code });
  }
  let roleId = assignment.roleId;
  // Match the primary create branch: a dynamic fallback does not fall back
  // to the pipeline's fixed role. Explicit clear remains roleless.
  if (!assignment.configured && primary.role_id && primary.role_id !== '__keep__') {
    roleId = primary.role_id === '__clear__' ? null : primary.role_id;
  }
  if (roleId === undefined) {
    const conditionOptions = rulesUseLmicOperators(form.visibility_rules)
      ? { lmicCodes: await loadTenantLmicCodes(db, form.tenant_id, { strict: true }) } : {};
    roleId = derivePersistedFormRole({
      defaultRoleId: form.default_member_role_id,
      visibilityRules: form.visibility_rules,
      answers,
      conditionOptions,
    }) || undefined;
  }
  if (roleId === undefined) {
    const { data, error } = await db.from('role').select('id')
      .eq('tenant_id', form.tenant_id).eq('is_default', true)
      .order('id', { ascending: true });
    if (error) throw error;
    roleId = data?.[0]?.id || null;
  }
  return { role_id: roleId };
}

function preferenceFields(fields) {
  return (fields || []).flatMap(field => [
    ...(field?.type === 'communication_preferences' ? [field] : []),
    ...(isRepeatableRowField(field)
      ? preferenceFields(normalizeRepeatableRowField(field).children) : []),
  ]);
}

// Member IDs here are references only. Admission must establish authority before
// private category metadata is queried; neither client role nor email is trusted.
export async function formCommunicationCategoriesHandler(req, res, dependencies = {}) {
  res.setHeader?.('Cache-Control', 'private, no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { formId, fieldId, memberId, applicantContinuationToken, draftToken, sourceAnswers = {} } = req.body || {};
  const validId = value => typeof value === 'string' && value.trim() && value.length <= 512;
  if (![formId, fieldId].every(validId) || (memberId != null && !validId(memberId))
    || !sourceAnswers || typeof sourceAnswers !== 'object' || Array.isArray(sourceAnswers)) {
    return res.status(400).json({ error: 'Valid formId, fieldId, optional memberId and sourceAnswers are required' });
  }
  const db = dependencies.db || (
    process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY
      ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY) : null
  );
  if (!db) return res.status(503).json({ error: 'Database not configured' });
  try {
    const tenant = await (dependencies.resolveTenant || resolveTenantFromRequest)(req);
    if (!tenant?.id) return res.status(404).json({ error: 'Tenant not found' });
    const { data: form, error: formError } = await db.from('form').select('*')
      .eq('tenant_id', tenant.id).eq('id', formId).eq('is_active', true).maybeSingle();
    if (formError) throw formError;
    // Survey snapshots have their own assignment admission contract.
    if (!form || !isFormScheduleAvailable(form) || form.form_type === 'survey') {
      return res.status(404).json({ error: 'Form not found or unavailable' });
    }
    const access = await (dependencies.resolveAccess || resolveFormAccess)({
      supabase: db, req, tenantId: tenant.id, policy: form.access_policy,
    });
    if (!access.allowed) return sendFormAccessDenied(res, access);
    const fields = preferenceFields(form.fields).filter(field => field.id === fieldId);
    if (fields.length !== 1) return res.status(404).json({ error: 'Communication preferences field not found' });
    const field = fields[0];
    const sessionMember = await (dependencies.getSessionMember || getSessionMember)(req);
    const verifiedMember = (sessionMember?.tenant_id || sessionMember?.organization?.tenant_id) === tenant.id
      ? sessionMember : null;
    const context = await (dependencies.getTenantContext || getTenantContext)(req);
    const verifiedAdminAccess = context?.tenantId === tenant.id
      && await (dependencies.hasAdminAccess || hasAdminAccess)(context);
    if ((form.require_authentication || form.mutation_access_policy?.mode === 'authenticated_owner')
      && !verifiedMember && !verifiedAdminAccess) {
      return res.status(403).json({ error: 'Authentication is required to access this form' });
    }
    const { applicantGrant } = await authorizeApplicantAdmission({
      db, form, token: applicantContinuationToken, resumeToken: draftToken,
      verifiedMember, verifiedAdminAccess,
    });
    let member;
    if (memberId) {
      const legacy = await createLegacyApplicationScope({ db, form, memberId });
      const applicantMemberIds = applicantGrant
        ? await loadApplicantMemberScope({ db, form, grant: applicantGrant }) : [];
      if (!verifiedAdminAccess && verifiedMember?.id !== memberId
        && !legacy?.member_ids.includes(memberId) && !applicantMemberIds.includes(memberId)) {
        return res.status(403).json({ error: 'Member preferences are unavailable for this form' });
      }
      const result = await db.from('member').select('id, role_id')
        .eq('tenant_id', tenant.id).eq('id', memberId).maybeSingle();
      if (result.error) throw result.error;
      member = result.data;
    } else {
      member = await resolveCreationCommunicationMember({ db, form, sourceAnswers });
    }
    if (!member) return res.status(403).json({ error: 'Member preferences are unavailable for this form' });
    let query = db.from('communication_category')
      .select('id, name, description, is_public, member_enabled')
      .eq('tenant_id', tenant.id).eq('is_active', true);
    if (Array.isArray(field.allowed_category_ids) && field.allowed_category_ids.length) {
      query = query.in('id', field.allowed_category_ids);
    }
    const { data: categories, error: categoryError } = await query.order('display_order', { ascending: true });
    if (categoryError) throw categoryError;
    if (!categories?.length) return res.json([]);
    const { data: roles, error: roleError } = await db.from('communication_category_role')
      .select('category_id, role_id').eq('tenant_id', tenant.id)
      .in('category_id', categories.map(category => category.id));
    if (roleError) throw roleError;
    return res.json(attachCommunicationCategoryRoleIds(
      filterCommunicationCategoriesForMember(categories, roles, member), roles,
    ));
  } catch (error) {
    if (error instanceof FormApplicantContinuationError) {
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
    if (error.code === 'INVALID_MEMBER_ROLE_ANSWER' || error.code === 'INVALID_MEMBER_ROLE_MAPPING') {
      return res.status(400).json({ error: error.message, code: error.code });
    }
    return res.status(500).json({ error: 'Failed to load member communication categories' });
  }
}

export default function handler(req, res) {
  return formCommunicationCategoriesHandler(req, res);
}