import test from 'node:test';
import assert from 'node:assert/strict';
import { createLegacyApplicationScope, loadLegacyApplicationScope } from './formLegacyApplication.js';
import { assessFormMutationAccess, resolveFormAccessOverride, normalizeFormMutationAccess } from '../../shared/formMutationContract.js';
import { assertStructuredMutationAuthorized } from './formStructuredActions.js';
import { stripGenericServerOwnedFields } from './serverOwnedEntityBoundary.js';

const form = {
  id: 'form', tenant_id: 'tenant', require_authentication: false,
  mutation_access_policy: { version: 1, mode: 'legacy_public_application' },
  entity_pipelines: [{ id: 'org', target_entity: 'organization', action: 'update',
    mappings: [{ source_field_id: 'name', target_type: 'core', target_field: 'phone' }] }],
};
function database(rows) {
  return { from(table) {
    const filters = [];
    const query = {
      select() { return this; },
      eq(key, value) { filters.push(row => row[key] === value); return this; },
      order() { return this; },
      async range(start, end) { return { data: (rows[table] || []).filter(row => filters.every(f => f(row))).slice(start, end + 1) }; },
      async maybeSingle() { return { data: (rows[table] || []).find(row => filters.every(f => f(row))) || null }; },
    };
    return query;
  } };
}
const rows = {
  organization: [{ id: 'org', tenant_id: 'tenant' }, { id: 'foreign', tenant_id: 'other' }],
  member: [{ id: 'member', tenant_id: 'tenant', organization_id: 'org' }],
};
test('editor Automatic preserves an approved legacy mode without opting in new forms', () => {
  const automatic = resolveFormAccessOverride(form, 'none');
  assert.equal(normalizeFormMutationAccess({ ...form, mutation_access_policy: automatic }).mutation_access_policy.mode, 'legacy_public_application');
  assert.equal(resolveFormAccessOverride({}, 'none'), null);
  assert.deepEqual(resolveFormAccessOverride(form, 'authenticated_owner'), { version: 1, mode: 'authenticated_owner' });
});
test('explicit public ID links create tenant-validated immutable processing scope', async () => {
  const db = database(rows);
  const scope = await createLegacyApplicationScope({ db, form, organizationId: 'org', memberId: 'member' });
  const submission = { id: 's', form_id: form.id, tenant_id: form.tenant_id, legacy_application_scope: scope };
  const loaded = await loadLegacyApplicationScope({ db, form, submission });
  const authorization = { verifiedOrganizationId: loaded.organization_id, verifiedApplicantMemberIds: loaded.member_ids };
  assert.equal(assertStructuredMutationAuthorized({ action: { target: { kind: 'organization' } }, recordId: 'org', authorization }), true);
  assert.equal(assertStructuredMutationAuthorized({ action: { target: { kind: 'member' } }, recordId: 'member', authorization }), true);
  assert.throws(() => assertStructuredMutationAuthorized({ action: { target: { kind: 'organization' } }, recordId: 'foreign', authorization }));
  assert.deepEqual(stripGenericServerOwnedFields('FormSubmission', { legacy_application_scope: scope, status: 'new' }), { status: 'new' });
});
test('foreign, missing and changed targets cannot grant application scope', async () => {
  const db = database(rows);
  for (const organizationId of ['foreign', 'missing']) {
    await assert.rejects(createLegacyApplicationScope({ db, form, organizationId }), /unavailable/);
  }
  const scope = await createLegacyApplicationScope({ db, form, organizationId: 'org' });
  await assert.rejects(loadLegacyApplicationScope({ db, form, submission: { form_id: form.id, tenant_id: 'other', legacy_application_scope: scope } }));
  await assert.rejects(loadLegacyApplicationScope({ db, form: { ...form, fields: [{ id: 'changed' }] },
    submission: { form_id: form.id, tenant_id: form.tenant_id, legacy_application_scope: scope } }));
});
test('scope never expands to newly associated members on replay', async () => {
  const db = database(rows);
  const scope = await createLegacyApplicationScope({ db, form, organizationId: 'org' });
  const changed = database({ ...rows, member: [{ id: 'new', tenant_id: 'tenant', organization_id: 'org' }] });
  const loaded = await loadLegacyApplicationScope({ db: changed, form,
    submission: { form_id: form.id, tenant_id: form.tenant_id, legacy_application_scope: scope } });
  assert.deepEqual(loaded.member_ids, []);
});
test('login and other policy modes do not receive legacy authority', async () => {
  for (const protectedForm of [
    { ...form, require_authentication: true },
    { ...form, mutation_access_policy: null },
    { ...form, mutation_access_policy: { version: 1, mode: 'applicant_continuation' } },
  ]) assert.equal(await createLegacyApplicationScope({ db: database(rows), form: protectedForm, organizationId: 'org' }), null);
});
test('editor assessment permits explicit legacy mappings but rejects account security fields', () => {
  assert.equal(assessFormMutationAccess(form).ok, true);
  assert.equal(assessFormMutationAccess({ ...form, field_mappings: [
    { target_entity: 'member', target_type: 'core', target_field: 'password_hash', source_field_id: 'p' },
  ] }).ok, false);
});