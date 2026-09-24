import { createHash, randomBytes } from 'node:crypto';
import { supportsApplicantContinuationIssuance } from '../../shared/formMutationContract.js';

export class FormApplicantContinuationError extends Error {
  constructor(message = 'This applicant link is invalid, expired, revoked, or no longer matches the form.') {
    super(message);
    this.status = 403;
    this.code = 'APPLICANT_CONTINUATION_REQUIRED';
  }
}

const TABLE = 'form_applicant_continuation';
function continuationStorageMissing(error) {
  return error?.code === '42P01' || error?.code === 'PGRST205';
}
const CONFIG_KEYS = ['fields', 'pages', 'visibility_rules', 'field_mappings',
  'application_level', 'auto_create_entity', 'default_member_role_id', 'require_authentication',
  'access_policy', 'create_entity_type', 'entity_action', 'member_entity_action',
  'organization_entity_action', 'additional_member_creations', 'entity_pipelines',
  'structured_actions', 'mutation_access_policy'];
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
export const hashApplicantToken = token => createHash('sha256').update(token).digest('hex');
export function applicantConfigurationDigest(form) {
  return hashApplicantToken(JSON.stringify(canonical(Object.fromEntries(
    CONFIG_KEYS.map(key => [key, form[key] ?? null])))));
}
export function requiresApplicantContinuation(form) {
  return form?.mutation_access_policy?.version === 1
    && form.mutation_access_policy.mode === 'applicant_continuation';
}
export function canIssueApplicantContinuation(form) {
  return supportsApplicantContinuationIssuance(form);
}
// Inputs are server-resolved session capabilities, never request claims.
// A supplied bearer remains fail-closed even when a session is also present.
export async function authorizeApplicantAdmission({
  db, form, token, resumeToken, requestedOrganizationId = null,
  verifiedMember = null, verifiedAdminAccess = false,
}) {
  const memberTenantId = verifiedMember?.tenant_id || verifiedMember?.organization?.tenant_id;
  const memberOrganizationId = verifiedMember?.id && memberTenantId === form.tenant_id
    ? verifiedMember.organization_id : null;
  const sessionAuthorized = verifiedAdminAccess === true || !!memberOrganizationId;
  const grant = token || resumeToken
    ? await verifyApplicantContinuation({
      db, form, token, resumeToken,
      allowUnboundResume: !requiresApplicantContinuation(form) || sessionAuthorized,
    }) : null;
  if (grant) {
    if (requestedOrganizationId && requestedOrganizationId !== grant.organization_id) {
      throw new FormApplicantContinuationError('The selected organization does not match this applicant link.');
    }
    return { applicantGrant: grant, organizationId: grant.organization_id };
  }
  if (!requiresApplicantContinuation(form)) {
    return { applicantGrant: null, organizationId: requestedOrganizationId };
  }
  if (!sessionAuthorized) throw new FormApplicantContinuationError();
  if (!verifiedAdminAccess && requestedOrganizationId && requestedOrganizationId !== memberOrganizationId) {
    throw new FormApplicantContinuationError('The selected organization is not owned by this session.');
  }
  const organizationId = verifiedAdminAccess ? requestedOrganizationId : memberOrganizationId;
  if (organizationId) {
    const { data, error } = await db.from('organization').select('id')
      .eq('tenant_id', form.tenant_id).eq('id', organizationId).maybeSingle();
    if (error) throw error;
    if (!data) throw new FormApplicantContinuationError('Organization is unavailable in this tenant.');
  }
  return { applicantGrant: null, organizationId };
}
async function organizationMemberIds(db, tenantId, organizationId) {
  const ids = [];
  for (let start = 0; ; start += 500) {
    const { data, error } = await db.from('member').select('id')
      .eq('tenant_id', tenantId).eq('organization_id', organizationId)
      .order('id').range(start, start + 499);
    if (error) throw error;
    ids.push(...(data || []).map(row => row.id));
    if (!data || data.length < 500) return ids;
  }
}
export async function loadApplicantMemberScope({ db, form, grant }) {
  // Older grants without an explicit immutable member snapshot authorize none.
  if (!Array.isArray(grant?.member_ids) || !grant.member_ids.length) return [];
  validateGrant(grant, form, { allowBoundProcessing: true });
  const currentIds = new Set(await organizationMemberIds(db, form.tenant_id, grant.organization_id));
  return grant.member_ids.filter(id => currentIds.has(id));
}
function validateGrant(grant, form, { allowBoundProcessing = false } = {}) {
  const bound = allowBoundProcessing && grant?.submission_id
    && Number.isFinite(Date.parse(grant.bound_at));
  if (!grant || !grant.organization_id || grant.revoked_at || (!bound && Date.parse(grant.expires_at) <= Date.now())
    || !Number.isFinite(Date.parse(grant.expires_at))
    || grant.tenant_id !== form.tenant_id || grant.form_id !== form.id
    || grant.configuration_digest !== applicantConfigurationDigest(form)) {
    throw new FormApplicantContinuationError();
  }
  return grant;
}
async function requireAttachedGrantOrganization(db, grant) {
  if (!grant?.organization_id || grant.revoked_at) throw new FormApplicantContinuationError();
  const { data, error } = await db.from('organization').select('id')
    .eq('tenant_id', grant.tenant_id).eq('id', grant.organization_id).maybeSingle();
  if (error) throw error;
  if (!data) {
    throw new FormApplicantContinuationError(
      'The organization for this applicant link is no longer available.',
    );
  }
}
// Server-only API: callers must establish administrator/workflow authority.
export async function issueApplicantContinuation({ db, form, organizationId, issuedBy = null }) {
  if (!canIssueApplicantContinuation(form)) {
    throw new FormApplicantContinuationError('Enable applicant continuation access on this form before issuing a link.');
  }
  const { data: organization, error } = await db.from('organization').select('id')
    .eq('tenant_id', form.tenant_id).eq('id', organizationId).maybeSingle();
  if (error) throw error;
  if (!organization) throw new FormApplicantContinuationError('Organization is unavailable in this tenant.');
  const memberIds = await organizationMemberIds(db, form.tenant_id, organization.id);
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + 30 * 86400000).toISOString();
  const { error: insertError } = await db.from(TABLE).insert({
    tenant_id: form.tenant_id, form_id: form.id, organization_id: organization.id,
    token_hash: hashApplicantToken(token), configuration_digest: applicantConfigurationDigest(form),
    expires_at: expiresAt, issued_by: issuedBy,
    member_ids: memberIds,
  });
  if (insertError) throw insertError;
  return { applicant_continuation_token: token, expires_at: expiresAt,
    form_id: form.id, organization_id: organization.id };
}
export async function verifyApplicantContinuation({ db, form, token, resumeToken, allowUnboundResume = false }) {
  let grantId;
  if (!token && resumeToken) {
    if (typeof resumeToken !== 'string' || resumeToken.length > 512) throw new FormApplicantContinuationError();
    const { data: draft, error } = await db.from('form_draft_submission')
      .select('*').eq('tenant_id', form.tenant_id)
      .eq('form_id', form.id).eq('resume_token_hash', hashApplicantToken(resumeToken)).maybeSingle();
    if (error) throw error;
    if (!draft || !Number.isFinite(Date.parse(draft.expires_at))
      || Date.parse(draft.expires_at) <= Date.now()) throw new FormApplicantContinuationError();
    grantId = draft.applicant_continuation_id;
    if (!grantId && allowUnboundResume) return null;
  }
  if (!grantId && (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token))) {
    throw new FormApplicantContinuationError();
  }
  let query = db.from(TABLE).select('*').eq('tenant_id', form.tenant_id).eq('form_id', form.id);
  query = grantId ? query.eq('id', grantId) : query.eq('token_hash', hashApplicantToken(token));
  // Draft rows/IDs are not authority, even if another API can edit them.
  // The service-only grant must independently record this resume capability.
  if (grantId) query = query.contains('draft_token_hashes', [hashApplicantToken(resumeToken)]);
  const { data, error } = await query.maybeSingle();
  if (continuationStorageMissing(error)) throw new FormApplicantContinuationError('Applicant continuation access is not available until its database migration is installed.');
  if (error) throw error;
  const grant = validateGrant(data, form);
  await requireAttachedGrantOrganization(db, grant);
  return grant;
}
export async function bindApplicantDraft({ db, grant, resumeToken }) {
  await requireAttachedGrantOrganization(db, grant);
  const { data, error } = await db.rpc('bind_form_applicant_draft', {
    p_grant_id: grant.id, p_tenant_id: grant.tenant_id,
    p_token_hash: hashApplicantToken(resumeToken),
  });
  if (error) throw error;
  if (data !== true) throw new FormApplicantContinuationError();
}
export async function bindApplicantContinuation({ db, form, grant, submissionId }) {
  validateGrant(grant, form);
  await requireAttachedGrantOrganization(db, grant);
  const { data, error } = await db.rpc('bind_form_applicant_continuation', {
    p_grant_id: grant.id, p_tenant_id: form.tenant_id, p_form_id: form.id,
    p_submission_id: submissionId, p_digest: applicantConfigurationDigest(form),
  });
  if (error) throw error;
  if (data !== true) throw new FormApplicantContinuationError('This applicant link has already been used for another submission.');
}
export async function loadSubmissionApplicantContinuation({ db, form, submissionId }) {
  const { data, error } = await db.from(TABLE).select('*')
    .eq('tenant_id', form.tenant_id).eq('form_id', form.id)
    .eq('submission_id', submissionId).maybeSingle();
  // Absence cannot confer authority. This permits ordinary forms during the
  // staged schema rollout; required continuation policies still fail closed.
  if (continuationStorageMissing(error)) return null;
  if (error) throw error;
  if (!data) return null;
  if (data.submission_id !== submissionId || !Number.isFinite(Date.parse(data.bound_at))) {
    throw new FormApplicantContinuationError('The persisted applicant authorization is not bound to this submission.');
  }
  const grant = validateGrant(data, form, { allowBoundProcessing: true });
  await requireAttachedGrantOrganization(db, grant);
  return grant;
}