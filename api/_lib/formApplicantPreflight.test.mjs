import test from 'node:test';
import assert from 'node:assert/strict';
import { preflightApplicantTargets, resolveApplicantLegacyIdentityPlan } from './formApplicantPreflight.js';
import { assertStructuredMutationAuthorized } from './formStructuredActions.js';

const mapping = (field, target) => ({ source_type: 'field', source_field_id: field,
  target_type: 'core', target_field: target });
const form = { tenant_id: 'tenant', fields: [{ id: 'email1' }, { id: 'email2' }, { id: 'org' }],
  entity_pipelines: { members: [
    { isPrimary: true, mappings: [mapping('email1', 'email')] },
    { mappings: [mapping('email2', 'email')] },
  ], organisations: [{ isPrimary: true, mappings: [mapping('org', 'name')] }] } };
function dbFor(rows, error = null) {
  const queried = [];
  return { queried, from(table) {
    assert.ok(['member', 'organization'].includes(table), 'preflight only reads target tables');
    const filters = [];
    return { select() { return this; }, eq(key, value) { filters.push([key, value]); return this; },
      ilike(key, value) { filters.push([key, value]); return this; },
      limit() { return this; },
      then(resolve, reject) {
        queried.push([table, filters]);
        return Promise.resolve({ error, data: rows.filter(row => row.entity === table
          && filters.every(([key, value]) => row[key] === value)) }).then(resolve, reject);
      } };
  } };
}
const rows = [
  { entity: 'organization', id: 'org', name: 'Applicant org', tenant_id: 'tenant' },
  { entity: 'member', id: 'primary', email: 'primary@example.test', tenant_id: 'tenant' },
  { entity: 'member', id: 'secondary', email: 'secondary@example.test', tenant_id: 'tenant' },
  { entity: 'member', id: 'unrelated', email: 'other@example.test', tenant_id: 'tenant' },
];
const options = { form, grant: { organization_id: 'org' },
  memberIds: ['primary', 'secondary'], values: {
    email1: 'primary@example.test', email2: 'secondary@example.test', org: 'Applicant org',
  } };
test('GFI-shaped primary and additional contact upserts retain scoped existing-member authority', async () => {
  const db = dbFor(rows);
  await preflightApplicantTargets({ ...options, db });
  for (const recordId of options.memberIds) assert.equal(assertStructuredMutationAuthorized({
    action: { target: { kind: 'member' } }, recordId,
    authorization: { verifiedApplicantMemberIds: options.memberIds },
  }), true);
  assert.equal(db.queried.length, 3);
});
test('hostile additional contact email is rejected entirely within read-only preflight', async () => {
  const db = dbFor(rows);
  await assert.rejects(preflightApplicantTargets({
    ...options, db, values: { ...options.values, email2: 'other@example.test' },
  }), /outside this applicant link/);
  assert.throws(() => assertStructuredMutationAuthorized({
    action: { target: { kind: 'member' } }, recordId: 'unrelated',
    authorization: { verifiedApplicantMemberIds: options.memberIds },
  }));
});
test('missing member scope rejects existing contacts and lookup errors fail closed', async () => {
  await assert.rejects(preflightApplicantTargets({ ...options, db: dbFor(rows), memberIds: [] }));
  await assert.rejects(preflightApplicantTargets({ ...options, db: dbFor(rows, new Error('offline')) }), /offline/);
});
test('unmatched new contact emails remain valid creation requests', async () => {
  await preflightApplicantTargets({ ...options, db: dbFor(rows), memberIds: [],
    values: { email1: 'new1@example.test', email2: 'new2@example.test', org: 'Applicant org' } });
});

test('primary last effective email assignment wins without denying overwritten outsider', async () => {
  const candidate = { ...form, entity_pipelines: { members: [{
    isPrimary: true, mappings: [mapping('outsider', 'email'), mapping('email1', 'email')],
  }], organisations: form.entity_pipelines.organisations } };
  const values = { ...options.values, outsider: 'other@example.test' };
  assert.deepEqual(resolveApplicantLegacyIdentityPlan({ form: candidate, values }),
    [{ entity: 'member', column: 'email', value: 'primary@example.test' }]);
  await preflightApplicantTargets({ ...options, form: candidate, values, db: dbFor(rows) });
});

test('modern primary destinations shadow top-level identity even when opted-in hidden', async () => {
  const candidate = { ...form, field_mappings: [{
    ...mapping('outsider', 'email'), target_entity: 'member',
  }], entity_pipelines: { members: [{
    isPrimary: true, mappings: [{ ...mapping('email1', 'email'), ignore_if_hidden: true }],
  }], organisations: form.entity_pipelines.organisations } };
  const values = { ...options.values, outsider: 'other@example.test' };
  await preflightApplicantTargets({ ...options, form: candidate, values, db: dbFor(rows) });
  assert.deepEqual(resolveApplicantLegacyIdentityPlan({
    form: candidate, values, hiddenFieldIds: new Set(['email1']),
  }), []);
  await preflightApplicantTargets({ ...options, form: candidate, values,
    hiddenFieldIds: new Set(['email1']), db: dbFor(rows) });
});

test('unmapped reference-only member dropdown outside applicant org is not a mutation target', async () => {
  const candidate = { ...form, fields: [...form.fields, { id: 'reference', type: 'member_dropdown' }] };
  const values = { ...options.values, reference: 'unrelated' };
  const db = dbFor(rows);
  await preflightApplicantTargets({ ...options, form: candidate, values, db });
  assert.equal(db.queried.some(([, filters]) => filters.some(([key, value]) => key === 'id' && value === 'unrelated')), false);
});

test('member dropdown mapped to primary core still wins resolution and is authorized', async () => {
  const candidate = { ...form, fields: [...form.fields, { id: 'reference', type: 'member_dropdown' }],
    entity_pipelines: { members: [{ isPrimary: true, mappings: [
      mapping('reference', 'first_name'), mapping('email1', 'email'),
    ] }], organisations: form.entity_pipelines.organisations } };
  const values = { ...options.values, reference: 'unrelated' };
  assert.deepEqual(resolveApplicantLegacyIdentityPlan({ form: candidate, values }),
    [{ entity: 'member', column: 'id', value: 'unrelated' }]);
  await assert.rejects(preflightApplicantTargets({ ...options, form: candidate, values, db: dbFor(rows) }), /outside/);
});

test('additional member uses first effective email; modern pipelines replace legacy additional list', async () => {
  const candidate = { ...form,
    additional_member_creations: [{ mappings: [mapping('outsider', 'email')] }],
    entity_pipelines: { members: [{ isPrimary: true, mappings: [mapping('email1', 'email')] }, {
      mappings: [mapping('email2', 'email'), mapping('outsider', 'email')],
    }], organisations: form.entity_pipelines.organisations } };
  await preflightApplicantTargets({ ...options, form: candidate,
    values: { ...options.values, outsider: 'other@example.test' }, db: dbFor(rows) });
});

test('explicit hidden fallback group chooses its effective winner and blank later mapping is a no-op', async () => {
  const group = { version: 1, id: 'identity' };
  const candidate = { ...form, entity_pipelines: { members: [{
    isPrimary: true, mappings: [
      { ...mapping('outsider', 'email'), fallback_group: group, ignore_if_hidden: true },
      { ...mapping('email1', 'email'), fallback_group: group },
      mapping('blank', 'email'),
    ],
  }], organisations: form.entity_pipelines.organisations } };
  await preflightApplicantTargets({ ...options, form: candidate, hiddenFieldIds: new Set(['outsider']),
    values: { ...options.values, outsider: 'other@example.test', blank: '' }, db: dbFor(rows) });
});

test('implicit identity bindings apply only without top-level mappings and explicit clear removes prior identity', () => {
  const candidate = { ...form, fields: [{ id: 'outsider', core_field_mapping: 'member.email' }],
    field_mappings: [{ ...mapping('email1', 'email'), target_entity: 'member' }],
    entity_pipelines: null, member_entity_action: 'upsert' };
  assert.deepEqual(resolveApplicantLegacyIdentityPlan({
    form: candidate, values: { email1: 'primary@example.test', outsider: 'other@example.test' },
  }), [{ entity: 'member', column: 'email', value: 'primary@example.test' }]);
  candidate.field_mappings.push({ source_type: 'clear', target_entity: 'member', target_type: 'core', target_field: 'email' });
  assert.deepEqual(resolveApplicantLegacyIdentityPlan({
    form: candidate, values: { email1: 'primary@example.test', outsider: 'other@example.test' },
  }), []);
});

test('grant organization prefill beats a mapped name matching another organization', async () => {
  const db = dbFor([...rows, { entity: 'organization', id: 'unrelated-org',
    name: 'Other org', tenant_id: 'tenant' }]);
  await preflightApplicantTargets({ ...options, db, values: { ...options.values, org: 'Other org' } });
  assert.equal(db.queried.some(([entity, filters]) => entity === 'organization'
    && filters.some(([key]) => key === 'name')), false);
});