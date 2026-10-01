import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compatibilityForm,
  submitThroughRealProcessor,
  TENANT_ID,
  SUBMISSION_ID,
} from './formSubmissionCompatibility.helpers.mjs';

const ORGANIZATION_ID = '7dc51049-90dc-42cf-9567-2b128321c21c';
const member = {
  id: 'verified-member',
  tenant_id: TENANT_ID,
  organization_id: ORGANIZATION_ID,
  first_name: 'Verified',
  last_name: 'Member',
  email: 'verified@example.test',
};

function standardForm(overrides = {}) {
  return {
    ...compatibilityForm(),
    form_type: 'standard',
    require_authentication: true,
    fields: [{ id: 'feedback', type: 'text' }],
    organization_entity_action: 'none',
    entity_pipelines: { members: [], organisations: [] },
    ...overrides,
  };
}

function assertNoWrites(result) {
  assert.deepEqual(result.writes, []);
  assert.deepEqual(result.insertedSubmissions, []);
  assert.deepEqual(result.handoffs, []);
  assert.deepEqual(result.processorResults, []);
  assert.equal(result.emailInvocations, 0);
}

for (const scenario of [
  { name: 'direct tenant', sessionMember: member },
  { name: 'tenant inherited from organization', sessionMember: {
    ...member, tenant_id: null, organization: { id: ORGANIZATION_ID, tenant_id: TENANT_ID },
  } },
  { name: 'direct tenant without an organization', sessionMember: {
    ...member, organization_id: null, organization: null,
  } },
  { name: 'legacy null form type', sessionMember: member, formType: null },
]) {
  test(`login-required standard form saves exactly once: ${scenario.name}`, async () => {
    const submissionData = { feedback: 'A complete authenticated submission' };
    const result = await submitThroughRealProcessor({
      form: standardForm({ form_type: scenario.formType === null ? null : 'standard' }),
      sessionMember: scenario.sessionMember,
      submissionData,
      requestBodyOverrides: {
        submitted_by_name: 'Forged Name', submitted_by_email: 'forged@example.test',
        verified_submitter_member_id: 'forged-member',
      },
    });
    assert.equal(result.response.statusCode, 201, JSON.stringify(result.response.body));
    assert.equal(result.insertedSubmissions.length, 1);
    assert.equal(result.writes.filter(write => write.operation === 'insert').length, 1);
    const [saved] = result.insertedSubmissions;
    assert.deepEqual(saved.submission_data, submissionData);
    assert.equal(saved.tenant_id, TENANT_ID);
    assert.equal(saved.submitted_by_name, 'Verified Member');
    assert.equal(saved.submitted_by_email, member.email);
    assert.deepEqual(result.deletedSubmissionIds, []);
    assert.equal(result.emailInvocations, 1);
    assert.equal(result.emailDeliveries, 1);
  });
}

for (const scenario of [
  { name: 'anonymous' },
  { name: 'wrong tenant', sessionMember: { ...member, tenant_id: 'another-tenant' } },
  { name: 'wrong direct tenant cannot be overridden by organization', sessionMember: {
    ...member, tenant_id: 'another-tenant', organization: { tenant_id: TENANT_ID },
  } },
  { name: 'wrong inherited tenant', sessionMember: {
    ...member, tenant_id: null, organization: { tenant_id: 'another-tenant' },
  } },
  { name: 'session lookup failure', getSessionMember: async () => { throw new Error('Fixture session lookup failure'); } },
  { name: 'forged client identity', requestBodyOverrides: {
    member_id: member.id, tenant_id: TENANT_ID, submitted_by_name: 'Verified Member',
    submitted_by_email: member.email, verified_submitter_member_id: member.id,
    verified_admin_access: true, is_admin: true, hasTenantSession: true,
    sessionMember: member,
  } },
  { name: 'admin-only session is not a general login bypass', adminTenantId: TENANT_ID },
]) {
  test(`login-required standard form rejects without writes: ${scenario.name}`, async () => {
    const result = await submitThroughRealProcessor({
      form: standardForm(), submissionData: { feedback: 'Must not save' }, ...scenario,
    });
    assert.equal(result.response.statusCode, 403, JSON.stringify(result.response.body));
    assert.equal(result.response.body.error, 'This form requires authentication');
    assertNoWrites(result);
  });
}

test('same-tenant login does not bypass the independent audience policy gate', async () => {
  // Only the login lookup is injected. The real audience resolver still needs
  // its own active session and must reject this request with no session cookie.
  const result = await submitThroughRealProcessor({
    form: standardForm({ access_policy: {
      version: 1, operator: 'and', group_rules: [], rbac_role_ids: ['restricted-role'],
    } }),
    sessionMember: member,
    submissionData: { feedback: 'Outside audience' },
    requestBodyOverrides: { role_id: 'restricted-role' },
  });
  assert.equal(result.response.statusCode, 403);
  assert.equal(result.response.body.code, 'AUTHENTICATION_REQUIRED');
  assert.equal(result.response.body.access_policy_required, true);
  assertNoWrites(result);
});

test('same-tenant login cannot bypass applicant ownership before the login gate', async () => {
  const result = await submitThroughRealProcessor({
    form: { ...compatibilityForm({ mutatePhone: true }), require_authentication: true,
      mutation_access_policy: { version: 1, mode: 'applicant_continuation' } },
    sessionMember: { ...member, organization_id: 'different-organization' },
    prefillOrganizationId: ORGANIZATION_ID,
    submissionData: { organisation: ORGANIZATION_ID, org_phone: 'unauthorized' },
    processorOptions: { existingOrganization: { id: ORGANIZATION_ID, tenant_id: TENANT_ID } },
  });
  assert.equal(result.response.statusCode, 403);
  assert.equal(result.response.body.code, 'APPLICANT_CONTINUATION_REQUIRED');
  assertNoWrites(result);
});

test('standard login admission still cannot mutate an arbitrary existing organization in the real processor', async () => {
  const result = await submitThroughRealProcessor({
    form: { ...compatibilityForm({ mutatePhone: true }), form_type: 'standard', require_authentication: true },
    sessionMember: { ...member, organization_id: null },
    submissionData: { organisation: ORGANIZATION_ID, org_phone: 'unauthorized' },
    requestBodyOverrides: { verified_submitter_member_id: 'organization-owner', verified_admin_access: true },
    processorOptions: { existingOrganization: {
      id: ORGANIZATION_ID, tenant_id: TENANT_ID, name: 'Existing Organization', phone: 'unchanged',
    } },
  });
  assert.equal(result.response.statusCode, 403, JSON.stringify(result.response.body));
  assert.equal(result.handoffs.length, 1);
  assert.equal(result.handoffs[0].verified_submitter_member_id, member.id);
  assert.equal(result.handoffs[0].verified_admin_access, false);
  const [processed] = result.processorResults;
  assert.equal(processed.response.statusCode, 403);
  assert.equal(processed.response.body.code, 'STRUCTURED_ACTION_FORBIDDEN');
  assert.equal(processed.updates.some(write => write.table === 'organization' || write.table === 'member'), false);
  assert.equal(processed.inserts.some(write => write.table === 'organization' || write.table === 'member'), false);
  assert.deepEqual(result.deletedSubmissionIds, [SUBMISSION_ID]);
  assert.equal(result.emailInvocations, 0);
});