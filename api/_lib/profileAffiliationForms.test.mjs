import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { emptyProfileFormPolicy, matchProfileForm, validateProfileFormPolicy, profileFormEligibility } from './profileAffiliationForms.js';
import { resolveProfileFormAffiliationAnswers } from './profileFormAffiliationAnswers.js';
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
test('staged draft has schema-valid empty actions and compatible profile bindings', async () => {
  const { form, config } = JSON.parse(await readFile(new URL('../../docs/profile-affiliation-form-staging.json', import.meta.url), 'utf8'));
  assert.deepEqual(form.structured_actions, { version: 1, actions: [] });
  assert.deepEqual(form.entity_pipelines, {});
  assert.equal(form.is_active, false);
  assert.equal(profileFormEligibility({ ...form, member_affiliation_enabled: true }, config), null);
});
test('routing uses ordered exact values, array membership, and explicit fallback', () => {
  const policy = { ...emptyProfileFormPolicy(), mappings: [{ value: 'Full', formId: id(1) }, { value: 'Full', formId: id(2) }],
    fallbackFormId: id(3) };
  assert.equal(matchProfileForm(policy, 'Full'), id(1));
  assert.equal(matchProfileForm(policy, ['Other', 'Full']), id(1));
  assert.equal(matchProfileForm(policy, 'Full with NMC'), id(3));
  assert.equal(matchProfileForm({ ...policy, fallbackFormId: null }, null), null);
});
test('admin configuration rejects unavailable forms and unknown member fields', () => {
  const policy = { ...emptyProfileFormPolicy(), enabled: true, fallbackFormId: id(1) };
  assert.throws(() => validateProfileFormPolicy(policy, { fields: [], forms: [] }), /unavailable/);
  const metadata = { fields: [], forms: [{ id: id(1), eligible: true }] };
  assert.equal(validateProfileFormPolicy(policy, metadata).fallbackFormId, id(1));
  assert.throws(() => validateProfileFormPolicy({ ...policy, fieldId: 'custom:foreign' }, metadata), /member field/);
});
test('profile eligibility excludes join/payment pipelines', () => {
  const form = { require_authentication: true, mutation_access_policy: { mode: 'authenticated_owner' },
    member_affiliation_enabled: true, form_type: 'standard', fields: [], entity_pipelines: {} };
  const config = { purpose: 'profile', enabled: true };
  assert.equal(profileFormEligibility(form, config), null);
  assert.match(profileFormEligibility({ ...form, fields: [{ type: 'membership_payment' }] }, config), /standalone/);
  assert.match(profileFormEligibility({ ...form, entity_pipelines: { members: [{}] } }, config), /standalone/);
});
const fixture = answers => ({
  form: { fields: [{ id: 'org', type: 'organisation_dropdown' }] }, hiddenFieldIds: new Set(), answers,
  snapshot: { member_id: id(1), profile_group_id: id(2),
    config: { purpose: 'profile', primaryOrganizationFieldIds: ['org'], organizationGroupFieldId: 'group', unknownOrganizationId: id(9) },
    graph: { organization_id: id(3), links: [], records: [], recordLinks: [] } },
});
test('unknown organisation or group uses approved fallback without a manual review', () => {
  for (const key of ['org', 'group']) {
    const plan = resolveProfileFormAffiliationAnswers(fixture({ [key]: '__form_not_listed__',
      __not_listed_choice_text: { [key]: 'Requested organisation' } }));
    assert.equal(plan.status, 'ready');
    assert.equal(plan.proposal.primary, id(9));
    assert.equal(plan.details[0].requestedName, 'Requested organisation');
    assert.equal(plan.baseline.primary, id(3));
  }
});
test('hidden unknown choices preserve original affiliations; explicit clear remains explicit', () => {
  const hidden = fixture({ org: '__form_not_listed__', group: '__form_not_listed__' });
  hidden.hiddenFieldIds = new Set(['org', 'group']);
  assert.deepEqual(resolveProfileFormAffiliationAnswers(hidden).proposal, { primary: id(3), departments: [], secondary: [], group: id(2) });
  assert.equal(resolveProfileFormAffiliationAnswers(fixture({ org: '' })).proposal.primary, null);
});
function additionalFixture(primaryAnswers = {}) {
  const input = fixture({
    ...primaryAnswers,
    sites: ['First unknown site', 'Second unknown site'].map((name, index) => ({
      _row_id: `row-${index}`, siteOrg: '__form_not_listed__',
      __not_listed_choice_text: { siteOrg: name },
    })),
  });
  input.form.fields.push({ id: 'sites', type: 'repeatable_rows', children: [{ id: 'siteOrg' }, { id: 'siteDepartments' }] });
  Object.assign(input.snapshot.config, { additionalSitesFieldId: 'sites',
    secondaryOrganizationFieldId: 'siteOrg', secondaryDepartmentsFieldId: 'siteDepartments' });
  return input;
}
test('several unknown additional sites consolidate fallback while retaining every name', () => {
  const input = additionalFixture();
  const originalAnswers = structuredClone(input.answers);
  const result = resolveProfileFormAffiliationAnswers(input);
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.proposal.secondary, [id(9)]);
  assert.deepEqual(result.details.map(d => d.requestedName), ['First unknown site', 'Second unknown site']);
  assert.deepEqual(result.details.map(d => d.rowKey), ['row-0', 'row-1']);
  assert.deepEqual(input.answers, originalAnswers);
});
test('unknown primary or Group shares one fallback with unknown additional sites', () => {
  for (const field of ['org', 'group']) {
    const result = resolveProfileFormAffiliationAnswers(additionalFixture({
      [field]: '__form_not_listed__', __not_listed_choice_text: { [field]: 'Unknown primary or group' },
    }));
    assert.equal(result.status, 'ready');
    assert.equal(result.proposal.primary, id(9));
    assert.deepEqual(result.proposal.secondary, []);
    assert.deepEqual(result.details.map(d => d.requestedName),
      ['Unknown primary or group', 'First unknown site', 'Second unknown site']);
  }
});
test('duplicate listed sites still fail in profile mode; renewal behavior is unchanged', () => {
  const input = additionalFixture();
  input.answers.sites.forEach(row => { row.siteOrg = id(8); });
  assert.throws(() => resolveProfileFormAffiliationAnswers(input), /distinct/);
});
