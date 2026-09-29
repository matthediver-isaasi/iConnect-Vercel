import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  assessFormMutationAccess,
  classifyFormMutationContract,
  hasFormMutationConfigChanged,
  supportsApplicantContinuationIssuance,
  validateFormMutationAccessSave,
} from '../shared/formMutationContract.js';
import {
  preflightApplicantTargets,
  preflightPublicMemberSignup,
} from '../api/_lib/formApplicantPreflight.js';

// No production connection: these are redacted configuration structures, not
// respondent records or authority tokens.
const fixture = JSON.parse(readFileSync(new URL('../tests/fixtures/gsf-form-access.json', import.meta.url), 'utf8'));
const bySlug = slug => {
  const result = fixture.forms.find(row => row.slug === slug);
  assert.ok(result, `missing pinned fixture: ${slug}`);
  return result.structure;
};
const policy = mode => ({ version: 1, mode });
const checked = (form, previousForm = form) =>
  validateFormMutationAccessSave({ form, previousForm });
const edited = form => ({ ...form, fields: [...form.fields, { id: 'audit-only-field', type: 'text' }] });

test('all 14 saved GSF structures replay real classification, assessment and save gates', () => {
  assert.equal(fixture.schemaVersion, 1);
  assert.equal(fixture.forms.length, 14);
  assert.equal(new Set(fixture.forms.map(row => row.slug)).size, 14);
  const expected = {
    enquiry: ['organization'],
    'so-renewal': ['organization'],
    'eso-renewal': ['organization'],
    'individual-join': ['member'],
    snapshot: ['member'],
  };
  for (const row of fixture.forms) {
    const form = row.structure;
    assert.ok(Array.isArray(form.fields), `${row.slug} must retain sanitized fields`);
    assert.deepEqual(classifyFormMutationContract(form).mutationTargets,
      expected[row.slug] || [], row.slug);
    assert.deepEqual(classifyFormMutationContract(form).mutationTargets,
      row.classification.mutationTargets, `${row.slug} inventory parity`);
    const assessment = assessFormMutationAccess(form);
    assert.equal(assessment.ok, !expected[row.slug], row.slug);
    assert.equal(assessment.ok, row.assessment.ok, row.slug);
    assert.equal(checked(form).ok, true, `unchanged save ${row.slug}`);
    assert.equal(checked(edited(form), form).ok, !expected[row.slug], `changed save ${row.slug}`);
    assert.equal(hasFormMutationConfigChanged(form, edited(form)), true, row.slug);
    assert.equal(hasFormMutationConfigChanged(form, { ...form, name: 'metadata only' }), false);
    assert.equal(checked({ ...form, name: 'metadata only' }, form).ok, true, row.slug);
    if (expected[row.slug]) {
      assert.equal(assessment.code, 'UNSAFE_EXISTING_RECORD_MUTATION_CONTRACT', row.slug);
      assert.equal(checked(form).legacyCompatibility, true, row.slug);
      assert.equal(checked(edited(form), form).code, 'UNSAFE_EXISTING_RECORD_MUTATION_CONTRACT', row.slug);
      assert.equal(validateFormMutationAccessSave({ form, isCreate: true }).ok, false, row.slug);
      const inactive = { ...edited(form), is_active: false };
      assert.equal(checked(inactive, form).ok, true, row.slug);
      assert.ok(checked(inactive, form).draftWarning, row.slug);
      assert.equal(assessFormMutationAccess(inactive).ok, false, row.slug);
      assert.equal(checked({ ...inactive, is_active: true }, inactive).ok, false, row.slug);
    } else {
      assert.equal(validateFormMutationAccessSave({ form, isCreate: true }).ok, true, row.slug);
    }
  }
});

test('pinned unaffected long forms and referenced organisation prefill are not mutations', () => {
  for (const slug of ['partner-application', 'so-application', 'eso-application',
    'so-application-fees', 'eso-application-fees']) {
    const form = bySlug(slug);
    assert.equal(classifyFormMutationContract(form).hasExistingRecordMutation, false, slug);
    assert.equal(supportsApplicantContinuationIssuance(form), false, slug);
    assert.equal(assessFormMutationAccess(form).ok, true, slug);
  }
});

test('member candidates preserve original mappings, permit explicit public signup, reject unsafe alternatives', () => {
  for (const slug of ['individual-join', 'snapshot']) {
    const original = bySlug(slug);
    const before = JSON.stringify(original.entity_pipelines);
    const signup = { ...original, mutation_access_policy: policy('public_member_signup') };
    assert.equal(assessFormMutationAccess(signup).ok, true, slug);
    assert.equal(checked(signup).ok, true, slug);
    assert.equal(validateFormMutationAccessSave({ form: signup, isCreate: true }).ok, true, slug);
    assert.equal(supportsApplicantContinuationIssuance(signup), false, slug);
    assert.equal(checked({ ...original, mutation_access_policy: policy('applicant_continuation') }).ok, false, slug);
    assert.equal(checked({ ...original, mutation_access_policy: policy('authenticated_owner') }).ok, false, slug);
    const owner = { ...original, require_authentication: true, mutation_access_policy: policy('authenticated_owner') };
    assert.equal(checked(owner).ok, true, slug);
    assert.equal(JSON.stringify(signup.entity_pipelines), before, slug);
    assert.equal(JSON.stringify(owner.entity_pipelines), before, slug);
  }
});

test('organisation candidates preserve mapped core/custom/static/date writes; owner and continuation alternatives pass save', () => {
  for (const slug of ['enquiry', 'so-renewal', 'eso-renewal']) {
    const original = bySlug(slug);
    const before = JSON.stringify(original.entity_pipelines);
    const continuation = { ...original, mutation_access_policy: policy('applicant_continuation') };
    assert.equal(supportsApplicantContinuationIssuance(original), true, slug);
    assert.equal(checked(continuation).ok, true, slug);
    assert.equal(checked(edited(continuation)).ok, true, slug);
    assert.equal(checked({ ...original, mutation_access_policy: policy('public_member_signup') }).ok, false, slug);
    const owner = { ...original, require_authentication: true, mutation_access_policy: policy('authenticated_owner') };
    assert.equal(checked(owner).ok, true, slug);
    assert.equal(JSON.stringify(owner.entity_pipelines), before, slug);
    assert.equal(JSON.stringify(continuation.entity_pipelines), before, slug);
    assert.equal(checked({ ...original, mutation_access_policy: { version: 9, mode: 'applicant_continuation' },
      is_active: false }).code, 'INVALID_FORM_MUTATION_ACCESS_POLICY', slug);
  }
  assert.ok(bySlug('enquiry').entity_pipelines.organisations[0].mappings.some(m => m.source_type === 'static'));
  for (const slug of ['so-renewal', 'eso-renewal']) {
    const mappings = bySlug(slug).entity_pipelines.organisations[0].mappings;
    assert.equal(mappings.length, 24, slug);
    assert.ok(mappings.some(m => m.source_type === 'current_date'), slug);
  }
});

function readOnlyDb(rows) {
  const queried = [];
  return { queried, from(table) {
    assert.ok(['member', 'organization'].includes(table));
    const filters = [];
    return {
      select(columns) { assert.equal(columns, 'id'); return this; },
      eq(column, value) { filters.push([column, value, false]); return this; },
      ilike(column, value) { filters.push([column, value, true]); return this; },
      limit(n) {
        assert.ok(n === 1 || n === 2);
        queried.push({ table, filters: [...filters] });
        return Promise.resolve({ data: rows.filter(row => row.table === table
          && filters.every(([key, value, insensitive]) => insensitive
            ? String(row[key]).toLowerCase() === String(value).toLowerCase()
            : row[key] === value)).slice(0, n), error: null });
      },
    };
  } };
}

test('actual GSF member pipelines: new identity, email collision, verified owner, forged ID and tenant scope', async () => {
  for (const slug of ['individual-join', 'snapshot']) {
    const original = bySlug(slug);
    const form = { ...original, tenant_id: 'gsf-test', mutation_access_policy: policy('public_member_signup') };
    const email = form.entity_pipelines.members[0].mappings.find(m => m.target_field === 'email');
    assert.ok(email?.source_field_id, slug);
    const values = { [email.source_field_id]: 'owner@example.test' };
    const rows = [
      { table: 'member', tenant_id: 'gsf-test', id: 'owner', email: 'owner@example.test' },
      { table: 'member', tenant_id: 'another-tenant', id: 'foreign', email: 'new@example.test' },
    ];
    const db = readOnlyDb(rows);
    await preflightPublicMemberSignup({ db, form,
      values: { [email.source_field_id]: 'new@example.test' } });
    await assert.rejects(preflightPublicMemberSignup({ db, form, values,
      // A forged draft token or answer email is not a verified server-side member.
      draftToken: 'pretend-owner', verifiedMember: null,
    }), { code: 'FORM_MEMBER_OWNER_REQUIRED' }, slug);
    await preflightPublicMemberSignup({ db, form, values,
      verifiedMember: { id: 'owner', tenant_id: 'gsf-test' } });
    await assert.rejects(preflightPublicMemberSignup({ db, form, values,
      verifiedMember: { id: 'owner', tenant_id: 'another-tenant' },
    }), { code: 'FORM_MEMBER_OWNER_REQUIRED' }, slug);
    await assert.rejects(preflightPublicMemberSignup({ db, form, values,
      verifiedMember: { id: 'wrong-owner', tenant_id: 'gsf-test' },
    }), { code: 'FORM_MEMBER_OWNER_REQUIRED' }, slug);
    await assert.rejects(preflightPublicMemberSignup({ db, form, values: {},
      primaryMemberId: 'owner',
    }), { code: 'FORM_MEMBER_OWNER_REQUIRED' }, slug);
    assert.ok(db.queried.length >= 5, slug);
    assert.ok(db.queried.every(query => query.filters.some(([key, value]) =>
      key === 'tenant_id' && value === 'gsf-test')), slug);
  }
});

test('actual GSF organisation candidates: server grant ID, scope and missing/foreign target fail closed', async () => {
  for (const slug of ['enquiry', 'so-renewal', 'eso-renewal']) {
    const form = { ...bySlug(slug), tenant_id: 'gsf-test',
      mutation_access_policy: policy('applicant_continuation') };
    const grant = { organization_id: 'approved-org' };
    const rows = [
      { table: 'organization', tenant_id: 'gsf-test', id: 'approved-org' },
      { table: 'organization', tenant_id: 'gsf-test', id: 'other-org' },
      { table: 'organization', tenant_id: 'foreign-tenant', id: 'foreign-org' },
    ];
    const db = readOnlyDb(rows);
    await preflightApplicantTargets({ db, form, grant, memberIds: [], values: {} });
    await assert.rejects(preflightApplicantTargets({ db, form,
      grant: { organization_id: 'missing-org' }, memberIds: [], values: {},
    }), /unavailable in this tenant/, slug);
    await assert.rejects(preflightApplicantTargets({ db, form,
      grant: { organization_id: 'foreign-org' }, memberIds: [], values: {},
    }), /unavailable in this tenant/, slug);
    const nameMapping = form.entity_pipelines.organisations[0].mappings.find(m =>
      m.target_field === 'name' && m.source_field_id);
    assert.ok(nameMapping, slug);
    await preflightApplicantTargets({ db, form, grant, memberIds: [],
      values: { [nameMapping.source_field_id]: 'Forged other org' } });
    assert.ok(db.queried.every(query => query.filters.some(([key, value]) =>
      key === 'tenant_id' && value === 'gsf-test')), slug);
    assert.ok(db.queried.every(query => !query.filters.some(([key]) => key === 'name')), slug);
    // The grant is assumed server-verified here; this preflight does NOT verify
    // a submitted bearer, draft token, or grant-to-form binding.
  }
});