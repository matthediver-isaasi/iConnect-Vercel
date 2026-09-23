import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  FORM_NOT_LISTED_TEXT_KEY,
  FORM_NOT_LISTED_VALUE,
} from '../../shared/formNotListedChoice.js';
import {
  compatibilityForm,
  makeContinuationGrant,
  invokePersistedContinuation,
  submitThroughRealProcessor,
  TENANT_ID,
} from './formSubmissionCompatibility.helpers.mjs';
import { hashApplicantToken } from '../_lib/formApplicantContinuation.js';

const ORGANIZATION_ID = '7dc51049-90dc-42cf-9567-2b128321c21c';
for (const scenario of [
  { name: 'verified owner', memberTenant: TENANT_ID, memberOrg: ORGANIZATION_ID, status: 201 },
  { name: 'verified administrator', adminTenant: TENANT_ID, status: 201 },
  { name: 'required-auth owner', memberTenant: TENANT_ID, memberOrg: ORGANIZATION_ID, requireAuth: true, status: 201 },
  { name: 'required-auth administrator', adminTenant: TENANT_ID, requireAuth: true, status: 201 },
  { name: 'owner of another organization', memberTenant: TENANT_ID, memberOrg: 'other-org', status: 403 },
  { name: 'cross-tenant member', memberTenant: 'other-tenant', memberOrg: ORGANIZATION_ID, status: 403 },
  { name: 'cross-tenant administrator', adminTenant: 'other-tenant', status: 403 },
  { name: 'unowned same-tenant session', memberTenant: TENANT_ID, status: 403 },
  { name: 'administrator targeting a cross-tenant organization', adminTenant: TENANT_ID, orgTenant: 'other-tenant', status: 403 },
  { name: 'raw organization without session', status: 403 },
]) {
  test(`explicit applicant policy admits only server-verified owner/admin without token: ${scenario.name}`, async () => {
    const form = { ...compatibilityForm({ mutatePhone: true }),
      require_authentication: !!scenario.requireAuth,
      mutation_access_policy: { version: 1, mode: 'applicant_continuation' } };
    const result = await submitThroughRealProcessor({
      form, prefillOrganizationId: ORGANIZATION_ID,
      submissionData: { organisation: ORGANIZATION_ID, org_phone: '020 7000 4710' },
      sessionMember: scenario.memberTenant ? {
        id: 'verified-owner', tenant_id: scenario.memberTenant,
        organization_id: scenario.memberOrg, email: 'owner@example.test',
      } : null,
      adminTenantId: scenario.adminTenant,
      processorOptions: { existingOrganization: {
        id: ORGANIZATION_ID, tenant_id: scenario.orgTenant || TENANT_ID, name: 'Existing Organization',
      } },
    });
    assert.equal(result.response.statusCode, scenario.status, JSON.stringify(result.response.body));
    if (scenario.status === 201) {
      assert.equal(result.processorResults[0].response.statusCode, 200);
      assert.ok(result.processorResults[0].updates.some(({ table }) => table === 'organization'));
    } else {
      assert.equal(result.handoffs.length, 0);
      assert.equal(result.insertedSubmissions.length, 0);
    }
  });
}
const variants = [
  { name: 'current', legacy: false },
  { name: 'legacy organization-name mapping', legacy: true },
];

for (const variant of variants) {
  test(`${variant.name}: public reference-only selection reaches the real processor without mutation`, async () => {
    const form = compatibilityForm({ legacy: variant.legacy });
    const result = await submitThroughRealProcessor({
      form,
      submissionData: { organisation: ORGANIZATION_ID },
      processorOptions: {
        existingOrganization: {
          id: ORGANIZATION_ID,
          tenant_id: TENANT_ID,
          name: 'Existing Organization',
        },
      },
    });

    assert.equal(result.response.statusCode, 201);
    assert.equal(result.handoffs.length, 1);
    assert.equal(result.handoffs[0].form_values.organisation, ORGANIZATION_ID);
    assert.equal(result.handoffs[0].verified_submitter_member_id, null);
    assert.equal(result.processorResults[0].response.statusCode, 200);
    assert.equal(result.processorResults[0].response.body.organization_id, ORGANIZATION_ID);
    assert.equal(result.processorResults[0].updates.some(({ table }) => table === 'organization'), false);
  });

  test(`${variant.name}: authenticated owner update keeps server-derived identity through the handoff`, async () => {
    const owner = {
      id: 'verified-owner',
      tenant_id: TENANT_ID,
      email: 'owner@example.test',
      organization_id: ORGANIZATION_ID,
    };
    const result = await submitThroughRealProcessor({
      form: compatibilityForm({ legacy: variant.legacy, mutatePhone: true }),
      submissionData: {
        organisation: ORGANIZATION_ID,
        org_phone: '020 7000 4710',
      },
      sessionMember: owner,
      processorOptions: {
        existingOrganization: {
          id: ORGANIZATION_ID,
          tenant_id: TENANT_ID,
          name: 'Existing Organization',
          phone: '020 7000 0000',
        },
      },
    });

    assert.equal(result.response.statusCode, 201);
    assert.equal(result.handoffs[0].verified_submitter_member_id, owner.id);
    assert.equal(result.processorResults[0].response.statusCode, 200);
    assert.equal(
      result.processorResults[0].updates.find(({ table }) => table === 'organization')?.payload.phone,
      '020 7000 4710',
    );
  });

  test(`${variant.name}: anonymous real-organization mutation is denied by the real processor`, async () => {
    const result = await submitThroughRealProcessor({
      form: compatibilityForm({ legacy: variant.legacy, mutatePhone: true }),
      submissionData: {
        organisation: ORGANIZATION_ID,
        org_phone: '020 7000 4710',
      },
      processorOptions: {
        existingOrganization: {
          id: ORGANIZATION_ID,
          tenant_id: TENANT_ID,
          name: 'Existing Organization',
          phone: '020 7000 0000',
        },
      },
    });

    assert.equal(result.response.statusCode, 403);
    assert.equal(result.processorResults[0].response.body.code, 'STRUCTURED_ACTION_FORBIDDEN');
    assert.equal(result.processorResults[0].updates.some(({ table }) => table === 'organization'), false);
    assert.deepEqual(result.deletedSubmissionIds, ['submission-runtime-org']);
  });
}

test('tampered identity and tenant values fail the signed processor boundary', async (t) => {
  const owner = {
    id: 'verified-owner',
    tenant_id: TENANT_ID,
    email: 'owner@example.test',
    organization_id: ORGANIZATION_ID,
  };
  for (const scenario of [{
    name: 'identity',
    tamper: () => ({ verified_submitter_member_id: 'attacker-member' }),
  }, {
    name: 'tenant',
    tamper: () => ({ tenant_id: 'attacker-tenant' }),
  }]) {
    await t.test(scenario.name, async () => {
      const result = await submitThroughRealProcessor({
        form: compatibilityForm(),
        submissionData: { organisation: ORGANIZATION_ID },
        sessionMember: owner,
        processorOptions: {
          existingOrganization: {
            id: ORGANIZATION_ID,
            tenant_id: TENANT_ID,
            name: 'Existing Organization',
          },
        },
        tamperProcessorBody: scenario.tamper,
      });
      assert.equal(result.response.statusCode, 403);
      assert.equal(result.processorResults[0].response.statusCode, 403);
      assert.equal(result.processorResults[0].updates.some(({ table }) => table === 'organization'), false);
    });
  }
});

test('visible Not-listed creates, while an ignored hidden selection cannot create', async () => {
  const notListedAnswers = {
    organisation: FORM_NOT_LISTED_VALUE,
    [FORM_NOT_LISTED_TEXT_KEY]: { organisation: 'New Compatibility Organization' },
  };
  const created = await submitThroughRealProcessor({
    form: compatibilityForm(),
    submissionData: notListedAnswers,
  });
  assert.equal(created.response.statusCode, 201);
  assert.equal(
    created.processorResults[0].inserts.find(({ table }) => table === 'organization')?.payload.name,
    'New Compatibility Organization',
  );

  const hidden = await submitThroughRealProcessor({
    form: compatibilityForm({ hidden: true }),
    submissionData: notListedAnswers,
  });
  assert.equal(hidden.response.statusCode, 201);
  assert.equal(hidden.processorResults[0].response.statusCode, 200);
  assert.equal(hidden.processorResults[0].inserts.some(({ table }) => table === 'organization'), false);
});

const fixtureUrls = [
  new URL('../../tests/fixtures/form-compatibility/57b94fc2-359d-434c-acd6-794865797ade.json', import.meta.url),
  new URL('../../tests/fixtures/form-compatibility/a47f37f1-b14a-4aea-8aee-cd0ebf7d9a8b.json', import.meta.url),
];
const sanitizedFixtures = await Promise.all(fixtureUrls.map(async url =>
  JSON.parse(await readFile(url, 'utf8'))));

function continuationForm(fixture) {
  return {
    id: fixture.formId,
    name: `Sanitized fixture ${fixture.formId}`,
    tenant_id: fixture.tenantAlias,
    ...structuredClone(fixture.structure),
    mutation_access_policy: { version: 1, mode: 'applicant_continuation' },
    allow_submitter_email_copy: false,
    prevent_duplicate_email_submission: false,
    is_event_related: false,
  };
}

function fixtureAnswers(form, organizationId) {
  const values = {};
  for (const field of form.fields) {
    if (field.type === 'email') values[field.id] = `${field.id}@example.test`;
    else if (field.type === 'number') values[field.id] = 47;
    else if (field.type === 'boolean' || field.type === 'terms_conditions') values[field.id] = true;
    else if (field.type === 'url') values[field.id] = 'https://example.test/application';
    else if (field.type === 'file') values[field.id] = 'https://example.test/application.pdf';
    else if (field.type === 'country') values[field.id] = 'GB';
    else values[field.id] = `value-${field.id}`;
  }
  for (const pipeline of form.entity_pipelines?.organisations || []) {
    for (const mapping of pipeline.mappings || []) {
      if (mapping.target_field === 'name') values[mapping.source_field_id] = organizationId;
    }
  }
  for (const pipeline of form.entity_pipelines?.members || []) {
    for (const mapping of pipeline.mappings || []) {
      if (mapping.target_field === 'organization_id') {
        values[mapping.source_field_id] = organizationId;
      }
    }
  }
  return values;
}

function fixturePreferenceFields(form) {
  const seen = new Set();
  return Object.values(form.entity_pipelines || {}).flat()
    .flatMap(pipeline => pipeline.mappings || [])
    .filter(mapping => mapping.target_type === 'custom' && mapping.target_field)
    .filter(mapping => !seen.has(`${mapping.target_entity}:${mapping.target_field}`)
      && seen.add(`${mapping.target_entity}:${mapping.target_field}`))
    .map(mapping => ({
      id: mapping.target_field,
      entity_scope: mapping.target_entity,
      field_type: 'text',
    }));
}

function fixtureRoles(form) {
  return (form.entity_pipelines?.members || [])
    .filter(pipeline => pipeline.role_id)
    .map(pipeline => ({ id: pipeline.role_id, tenant_id: form.tenant_id }));
}

for (const fixture of sanitizedFixtures) {
  test(`sanitized GFI ${fixture.formId}: continuation preserves configured mutation scope`, async () => {
    const form = continuationForm(fixture);
    const token = 'C'.repeat(43);
    const organization = {
      id: 'fixture-organization',
      tenant_id: form.tenant_id,
      name: 'Existing sanitized fixture organization',
      phone: 'old phone',
      invoicing_email: 'old@example.test',
      invoicing_address: 'old address',
    };
    const answers = fixtureAnswers(form, organization.id);
    const grant = makeContinuationGrant({
      form,
      token,
      organizationId: organization.id,
    });
    const result = await submitThroughRealProcessor({
      form,
      submissionData: answers,
      applicantContinuationToken: token,
      prefillOrganizationId: organization.id,
      continuationGrant: grant,
      idempotencyKey: `fixture-${fixture.formId}`,
      processorOptions: {
        existingOrganization: organization,
        preferenceFields: fixturePreferenceFields(form),
        roles: fixtureRoles(form),
      },
    });

    assert.equal(result.response.statusCode, 201);
    assert.equal(result.handoffs.length, 1, 'the persisted public row reaches the processor');
    assert.equal(result.processorResults[0].response.statusCode, 200);
    assert.equal(result.processorResults[0].response.body.organization_id, organization.id);
    assert.equal(grant.submission_id, 'submission-runtime-org');

    const memberPipeline = form.entity_pipelines?.members?.find(pipeline => pipeline.isPrimary);
    if (memberPipeline) {
      const memberInsert = result.processorResults[0].inserts.find(({ table }) => table === 'member');
      assert.ok(memberInsert, 'the real processor executes the fixture member pipeline');
      for (const mapping of memberPipeline.mappings.filter(mapping =>
        mapping.source_type === 'field' && mapping.target_type === 'core'
        && mapping.target_field !== 'organization_id')) {
        assert.equal(memberInsert.payload[mapping.target_field], answers[mapping.source_field_id]);
      }
      assert.equal(memberInsert.payload.organization_id, organization.id);
    }

    const organizationUpdate = result.processorResults[0].updates.find(
      ({ table }) => table === 'organization',
    );
    assert.ok(
      organizationUpdate,
      'the modern organization pipeline updates its granted target regardless of legacy action flags',
    );
    const expectedCoreMappings = form.entity_pipelines.organisations[0].mappings.filter(mapping =>
      mapping.source_type === 'field' && mapping.target_type === 'core'
      && mapping.target_field !== 'name' && answers[mapping.source_field_id] !== undefined);
    for (const mapping of expectedCoreMappings) {
      assert.equal(organizationUpdate.payload[mapping.target_field], answers[mapping.source_field_id]);
    }
    const expectedCustomMappings = form.entity_pipelines.organisations[0].mappings.filter(mapping =>
      mapping.source_type === 'field' && mapping.target_type === 'custom'
      && answers[mapping.source_field_id] !== undefined);
    const customWrites = result.processorResults[0].inserts.filter(
      ({ table }) => table === 'organization_preference_value',
    );
    for (const mapping of expectedCustomMappings) {
      assert.ok(customWrites.some(({ payload }) =>
        payload.field_id === mapping.target_field
        && String(payload.value) === String(answers[mapping.source_field_id])),
      `custom organization mapping ${mapping.id} is preserved`);
    }
    assert.equal(
      result.processorResults[0].response.body.organization_id,
      organization.id,
      'application result remains related to the granted organization',
    );
  });
}

test('GFI continuation member snapshot permits only an existing member from the granted organization', async (t) => {
  const fixture = sanitizedFixtures[0];
  const form = continuationForm(fixture);
  const organization = {
    id: 'fixture-organization',
    tenant_id: form.tenant_id,
    name: 'Existing sanitized fixture organization',
    phone: 'old phone',
  };
  const answers = fixtureAnswers(form, organization.id);
  const primaryPipeline = form.entity_pipelines.members.find(pipeline => pipeline.isPrimary);
  const emailMapping = primaryPipeline.mappings.find(mapping => mapping.target_field === 'email');
  const member = {
    id: 'existing-fixture-member',
    tenant_id: form.tenant_id,
    organization_id: organization.id,
    email: answers[emailMapping.source_field_id],
    first_name: 'Before',
    last_name: 'Applicant',
  };

  await t.test('member in immutable grant scope updates with the organization', async () => {
    const token = 'M'.repeat(43);
    const grant = makeContinuationGrant({
      form,
      token,
      organizationId: organization.id,
      overrides: { member_ids: [member.id] },
    });
    const result = await submitThroughRealProcessor({
      form,
      submissionData: answers,
      applicantContinuationToken: token,
      continuationGrant: grant,
      prefillOrganizationId: organization.id,
      processorOptions: {
        existingOrganization: organization,
        existingMember: member,
        preferenceFields: fixturePreferenceFields(form),
        roles: fixtureRoles(form),
      },
    });
    assert.equal(result.response.statusCode, 201);
    assert.ok(result.processorResults[0].updates.some(({ table }) => table === 'member'));
    assert.ok(result.processorResults[0].updates.some(({ table }) => table === 'organization'));
    assert.equal(result.processorResults[0].inserts.some(
      ({ table, payload }) => table === 'member' && payload.email === member.email,
    ), false, 'the scoped existing member is updated rather than duplicated');
  });

  await t.test('member outside immutable grant scope is denied before organization mutation', async () => {
    const token = 'N'.repeat(43);
    const grant = makeContinuationGrant({
      form,
      token,
      organizationId: organization.id,
      overrides: { member_ids: ['different-member'] },
    });
    const result = await submitThroughRealProcessor({
      form,
      submissionData: answers,
      applicantContinuationToken: token,
      continuationGrant: grant,
      prefillOrganizationId: organization.id,
      processorOptions: {
        existingOrganization: organization,
        existingMember: member,
        preferenceFields: fixturePreferenceFields(form),
        roles: fixtureRoles(form),
      },
    });
    assert.equal(result.response.statusCode, 403);
    assert.equal(result.processorResults[0].updates.some(({ table }) => table === 'organization'), false);
    assert.equal(result.processorResults[0].updates.some(({ table }) => table === 'member'), false);
  });
});

test('continuation retry reuses one durable submission and does not repeat processor creation', async () => {
  const fixture = sanitizedFixtures[0];
  const form = continuationForm(fixture);
  const token = 'R'.repeat(43);
  const organization = {
    id: 'fixture-organization',
    tenant_id: form.tenant_id,
    name: 'Existing sanitized fixture organization',
  };
  const grant = makeContinuationGrant({ form, token, organizationId: organization.id });
  const result = await submitThroughRealProcessor({
    form,
    submissionData: fixtureAnswers(form, organization.id),
    applicantContinuationToken: token,
    continuationGrant: grant,
    prefillOrganizationId: organization.id,
    idempotencyKey: 'continuation-retry',
    attempts: 2,
    processorOptions: {
      existingOrganization: organization,
      preferenceFields: fixturePreferenceFields(form),
      roles: fixtureRoles(form),
    },
  });
  assert.equal(result.responses[0].statusCode, 201);
  assert.equal(result.responses[1].statusCode, 200, JSON.stringify(result.responses[1].body));
  assert.equal(result.responses[1].body.duplicate, true);
  assert.equal(result.insertedSubmissions.length, 1);
  assert.equal(result.processorResults.length, 2, 'the applicant retry re-enters the idempotent processor');
  assert.equal(result.processorResults[1].inserts.some(
    ({ table }) => table === 'member' || table === 'organization',
  ), false, 'the completed processor checkpoint prevents duplicate entity creation');
});

test('continuation outage retry completes records, checkpoint, and email exactly once', async () => {
  const fixture = sanitizedFixtures[0];
  const form = continuationForm(fixture);
  const token = 'F'.repeat(43);
  const organization = {
    id: 'fixture-organization',
    tenant_id: form.tenant_id,
    name: 'Existing sanitized fixture organization',
  };
  const grant = makeContinuationGrant({ form, token, organizationId: organization.id });
  const result = await submitThroughRealProcessor({
    form,
    submissionData: fixtureAnswers(form, organization.id),
    applicantContinuationToken: token,
    continuationGrant: grant,
    prefillOrganizationId: organization.id,
    idempotencyKey: 'continuation-outage-retry',
    attempts: 3,
    failProcessorOnce: true,
    processorOptions: {
      existingOrganization: organization,
      preferenceFields: fixturePreferenceFields(form),
      roles: fixtureRoles(form),
    },
  });
  assert.equal(result.responses[0].statusCode, 503);
  assert.equal(result.responses[1].statusCode, 200, JSON.stringify(result.responses[1].body));
  assert.equal(result.responses[2].statusCode, 200);
  assert.equal(result.insertedSubmissions.length, 1);
  assert.equal(result.deletedSubmissionIds.length, 0);
  assert.equal(result.processorResults.length, 2);
  assert.equal(result.processorResults[1].inserts.some(
    ({ table }) => table === 'member' || table === 'organization',
  ), false);
  assert.equal(result.emailDeliveries, 1);
});

test('a grant-bound draft resume capability submits through the real processor without the raw grant', async () => {
  const fixture = sanitizedFixtures[1];
  const form = continuationForm(fixture);
  const organization = {
    id: 'fixture-organization',
    tenant_id: form.tenant_id,
    name: 'Existing sanitized fixture organization',
  };
  const resumeToken = 'draft-resume-capability';
  const grant = makeContinuationGrant({
    form,
    organizationId: organization.id,
    overrides: { draft_token_hashes: [hashApplicantToken(resumeToken)] },
  });
  const result = await submitThroughRealProcessor({
    form,
    submissionData: fixtureAnswers(form, organization.id),
    resumeToken,
    continuationGrant: grant,
    draft: {
      applicant_continuation_id: grant.id,
      resume_token_hash: hashApplicantToken(resumeToken),
      expires_at: new Date(Date.now() + 86400000).toISOString(),
    },
    prefillOrganizationId: organization.id,
    processorOptions: {
      existingOrganization: organization,
      preferenceFields: fixturePreferenceFields(form),
      roles: fixtureRoles(form),
    },
  });
  assert.equal(result.response.statusCode, 201);
  assert.equal(result.processorResults[0].response.statusCode, 200);
  assert.equal(grant.submission_id, 'submission-runtime-org');
});

test('deferred processor accepts an expired bound grant but rejects revocation before writes', async () => {
  const fixture = sanitizedFixtures[0];
  const form = continuationForm(fixture);
  const organization = {
    id: 'fixture-organization',
    tenant_id: form.tenant_id,
    name: 'Existing sanitized fixture organization',
  };
  const answers = fixtureAnswers(form, organization.id);
  const boundGrant = makeContinuationGrant({
    form,
    organizationId: organization.id,
    overrides: {
      submission_id: 'submission-runtime-org',
      bound_at: new Date(Date.now() - 86400000).toISOString(),
      expires_at: new Date(Date.now() - 1000).toISOString(),
    },
  });
  const options = {
    existingOrganization: organization,
    preferenceFields: fixturePreferenceFields(form),
    roles: fixtureRoles(form),
  };
  const accepted = await invokePersistedContinuation({
    form,
    submissionData: answers,
    grant: boundGrant,
    processorOptions: options,
  });
  assert.equal(accepted.response.statusCode, 200);
  assert.ok(accepted.updates.some(({ table }) => table === 'organization'));

  const revoked = await invokePersistedContinuation({
    form,
    submissionData: answers,
    grant: { ...boundGrant, revoked_at: new Date().toISOString() },
    processorOptions: options,
  });
  assert.equal(revoked.response.statusCode, 403);
  assert.equal(revoked.updates.some(
    ({ table }) => table === 'organization' || table === 'member',
  ), false);
  assert.equal(revoked.inserts.some(
    ({ table }) => table === 'organization' || table === 'member',
  ), false);
});

test('hostile continuation token, draft, scope, expiry, and configuration matrix fails before handoff', async (t) => {
  const fixture = sanitizedFixtures[0];
  const baseForm = continuationForm(fixture);
  const organization = {
    id: 'fixture-organization',
    tenant_id: baseForm.tenant_id,
    name: 'Existing sanitized fixture organization',
  };
  const validToken = 'V'.repeat(43);
  const validGrant = makeContinuationGrant({
    form: baseForm,
    token: validToken,
    organizationId: organization.id,
  });
  const resumeToken = 'resume-secret';
  const cases = [{
    name: 'raw organization id is not a token',
    token: organization.id,
    grant: validGrant,
  }, {
    name: 'draft row without a grant-bound resume hash',
    resumeToken,
    grant: validGrant,
    draft: {
      applicant_continuation_id: validGrant.id,
      resume_token_hash: hashApplicantToken(resumeToken),
      expires_at: new Date(Date.now() + 86400000).toISOString(),
    },
  }, {
    name: 'mismatched selected organization',
    token: validToken,
    grant: validGrant,
    prefillOrganizationId: 'other-organization',
  }, {
    name: 'expired grant',
    token: validToken,
    grant: { ...validGrant, expires_at: '2000-01-01T00:00:00.000Z' },
  }, {
    name: 'cross-tenant grant',
    token: validToken,
    grant: { ...validGrant, tenant_id: 'other-tenant' },
  }, {
    name: 'configuration drift',
    token: validToken,
    grant: { ...validGrant, configuration_digest: 'stale-configuration' },
  }];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const form = structuredClone(baseForm);
      const result = await submitThroughRealProcessor({
        form,
        submissionData: fixtureAnswers(form, organization.id),
        applicantContinuationToken: scenario.token ?? null,
        resumeToken: scenario.resumeToken ?? null,
        continuationGrant: structuredClone(scenario.grant),
        draft: scenario.draft,
        prefillOrganizationId: scenario.prefillOrganizationId ?? organization.id,
        processorOptions: { existingOrganization: organization },
      });
      assert.equal(result.response.statusCode, 403);
      assert.equal(result.response.body.code, 'APPLICANT_CONTINUATION_REQUIRED');
      assert.equal(result.handoffs.length, 0);
      assert.equal(result.insertedSubmissions.length, 0);
    });
  }
});