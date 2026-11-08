import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { connectDestination } from './lib/member-index-destination.mjs';
import { validateMemberAffiliationConfig } from '../api/_lib/formMemberAffiliationConfig.js';
import { computeHiddenFieldIds } from '../api/_lib/formFieldVisibility.js';

export const TARGET = 'fa639380-b5a0-4a5c-9d56-fb321d5d0d19';
const TENANT = 'ff2df806-b321-4254-b651-3af11fccf1db';
const JUNIOR = '824f5fda-7415-47f0-81a1-8bd85e589587';
const ORG = 'field_1788075690796';
const DEPT = 'field_1788075892819';
const CLASS = 'field_1788773081948';
const COUNTRY = 'field_1786371332409';
const ALIAS = 'field_1788940619910';
const KEYS = ['name', 'slug', 'require_authentication', 'prefill_source', 'prefill_source_field_id',
  'mutation_access_policy', 'due_diligence_required', 'uniqueness_checks',
  'fields', 'visibility_rules', 'entity_pipelines', 'member_affiliation_enabled'];
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function buildTraineeRenewal(original, traineeScheduleId) {
  assert.ok(traineeScheduleId, 'A verified Trainee schedule is required');
  assert.equal(original.id, TARGET);
  assert.equal(original.tenant_id, TENANT);
  assert.equal(original.member_affiliation_enabled, false);
  const form = structuredClone(original);
  const org = form.fields.find(f => f.id === ORG);
  const dept = form.fields.find(f => f.id === DEPT);
  const payment = form.fields.find(f => f.type === 'payment');
  const member = form.entity_pipelines.members.find(p => p.isPrimary);
  assert.ok(org && dept && payment && member);
  assert.deepEqual(form.fields.find(f => f.id === CLASS).options, ['Trainee']);
  const memberDepartmentDefinitionId = member.related_records.find(r => r.source_field_id === DEPT)?.relationship_definition_id;
  assert.ok(memberDepartmentDefinitionId);
  Object.assign(form, {
    name: 'Trainee renew', slug: 'trainee-renew',
    require_authentication: true, prefill_source: 'member', prefill_source_field_id: null,
    mutation_access_policy: { version: 1, mode: 'authenticated_owner' },
    due_diligence_required: false, member_affiliation_enabled: true,
  });
  form.uniqueness_checks = form.uniqueness_checks.filter(c => c.target_field !== 'member.email');
  if (org.parent_field_id && !form.fields.some(f => f.id === org.parent_field_id)) {
    delete org.parent_field_id;
    delete org.parent_field_scope;
  }
  payment.type = 'membership_payment';
  delete payment.stripe_billing_address_mappings;
  payment.membership_config_id = traineeScheduleId;
  payment.membership_schedule_mapping = { source_field_id: CLASS,
    entries: [{ value: 'Trainee', config_id: payment.membership_config_id }] };
  const countryField = form.fields.find(f => f.id === COUNTRY);
  countryField.prefill_field = 'org_custom:4f8b5c47-f074-4d15-96fd-0a44f81725eb';
  // Reuse saved member values, but do not prefill the pricing class from a
  // potentially different previous class or overwrite organisation-derived region.
  for (const mapping of member.mappings) {
    const field = form.fields.find(f => f.id === mapping.source_field_id);
    if (!field || field.prefill_field || field.id === CLASS || mapping.source_type !== 'field') continue;
    if (['text', 'textarea', 'email', 'tel', 'select', 'radio'].includes(field.type)) {
      if (mapping.target_type === 'core') field.prefill_field = `member:${mapping.target_field}`;
      if (mapping.target_type === 'custom') field.prefill_field = `member_custom:${mapping.target_field}`;
    }
  }
  form.entity_pipelines.organisations = [];
  delete member.login_enabled;
  member.related_records = [];
  // These join-only static writes must not reset an existing member's
  // application status, directory preference, or communication consent.
  member.mappings = member.mappings.filter(m => !(m.source_type === 'static' &&
    (m.static_value === 'Full application received' || m.target_field === 'show_in_directory'
      || m.target_type === 'communication')));
  const ids = new Set([...form.fields.map(f => f.id), ...form.pages.map(p => p.id)]);
  form.visibility_rules = form.visibility_rules.map(rule => {
    const copy = structuredClone(rule);
    copy.actions = copy.actions.filter(a => a.target_field_id !== ALIAS);
    for (const action of copy.actions) {
      if (action.action_type === 'visibility') {
        action.field_states = Object.fromEntries(Object.entries(action.field_states).filter(([id]) => ids.has(id)));
      }
      if (action.action_type === 'open_form') {
        assert.equal(action.destination_form_id, '8faff8a5-5671-41ef-a246-81810c34326d');
        action.destination_form_id = JUNIOR;
      }
      if (action.set_value_source === 'prefill' && action.target_field_id === 'field_1788273087721') {
        action.set_value_prefill_source_field_id = ORG;
      }
    }
    return copy;
  }).filter(r => r.actions.length);
  const config = {
    version: 1, enabled: true, primaryOrganizationFieldIds: [ORG],
    primaryDepartmentsFieldId: DEPT, memberDepartmentDefinitionId,
    departmentOrganizationDefinitionId: dept.relationship_definition_id,
    prefillAffiliationQuestions: true, countryFieldId: COUNTRY,
    organizationCountryFieldId: '4f8b5c47-f074-4d15-96fd-0a44f81725eb',
  };
  assert.deepEqual(form.fields.map(f => [f.id, f.label, f.page_id]), original.fields.map(f => [f.id, f.label, f.page_id]));
  for (const key of Object.keys(original)) if (!KEYS.includes(key)) assert.deepEqual(form[key], original[key], key);
  const uk = computeHiddenFieldIds(form, { [COUNTRY]: 'United Kingdom', [ORG]: 'hospital' });
  for (const id of [ORG, DEPT, payment.id]) assert.equal(uk.has(id), false);
  const abroad = computeHiddenFieldIds(form, { [COUNTRY]: 'France' });
  assert.equal(abroad.has(payment.id), true);
  return { form, config };
}

async function main() {
  const apply = process.argv.includes('--apply');
  const db = await connectDestination();
  try {
    await db.query(apply ? 'BEGIN' : 'BEGIN READ ONLY');
    await db.query("SET LOCAL lock_timeout='5s'");
    const forms = (await db.query(`select to_jsonb(f) row from form f
      where tenant_id=$1 and id=any($2::uuid[]) order by id${apply ? ' for update' : ''}`,
    [TENANT, [TARGET, JUNIOR]])).rows.map(r => r.row);
    const target = forms.find(f => f.id === TARGET);
    assert.ok(forms.find(f => f.id === JUNIOR)?.is_active);
    const conflicts = await db.query('select id from form where tenant_id=$1 and slug=$2 and id<>$3 and archived_at is null',
      [TENANT, 'trainee-renew', TARGET]);
    assert.equal(conflicts.rowCount, 0, 'Slug already in use');
    assert.equal((await db.query('select form_id from form_member_affiliation_config where form_id=$1', [TARGET])).rowCount, 0);
    const schedules = (await db.query('select id,structure_field_id,structure_scope_type from membership_tier_config where tenant_id=$1 and structure_match_value=$2',
      [TENANT, 'Trainee'])).rows;
    assert.equal(schedules.length, 1, 'A unique Trainee schedule is required');
    const schedule = schedules[0];
    assert.equal(schedule?.structure_scope_type, 'member');
    assert.equal(schedule.structure_field_id, '87f120ff-92e6-4d52-944b-9ba9d7b1fac0');
    const { form, config } = buildTraineeRenewal(target, schedule.id);
    const relationships = (await db.query('select * from custom_object_relationship_definition where tenant_id=$1 and id=any($2::uuid[])',
      [TENANT, [config.memberDepartmentDefinitionId, config.departmentOrganizationDefinitionId]])).rows;
    const validated = validateMemberAffiliationConfig(form, config, { complete: true, relationships, objects: [], fields: {} });
    const digest = hash({ forms, relationships, schedule });
    if (apply) {
      assert.ok(process.argv.includes(`--review-sha256=${digest}`), 'Live configuration changed or missing review hash');
      await mkdir('generated-artifacts/form-config-backups', { recursive: true });
      await writeFile(`generated-artifacts/form-config-backups/trainee-renewal-${digest}.json`,
        JSON.stringify({ formId: TARGET, before: Object.fromEntries(KEYS.map(k => [k, target[k]])), configBefore: null }, null, 2),
        { flag: 'wx', mode: 0o600 });
      await db.query('insert into form_member_affiliation_config(tenant_id,form_id,config) values($1,$2,$3::jsonb)',
        [TENANT, TARGET, JSON.stringify(validated)]);
      const patch = Object.fromEntries(KEYS.map(k => [k, form[k]]));
      await db.query(`update form set ${KEYS.map(k => `"${k}"=(jsonb_populate_record(null::public.form,$1::jsonb))."${k}"`).join(',')}
        where tenant_id=$2 and id=$3`, [JSON.stringify(patch), TENANT, TARGET]);
      assert.deepEqual((await db.query('select to_jsonb(f) row from form f where id=$1', [TARGET])).rows[0].row, form);
      assert.deepEqual((await db.query('select to_jsonb(f) row from form f where id=$1', [JUNIOR])).rows[0].row, forms.find(f => f.id === JUNIOR));
      assert.deepEqual((await db.query('select config from form_member_affiliation_config where form_id=$1', [TARGET])).rows[0].config, validated);
      await db.query('COMMIT');
    } else await db.query('ROLLBACK');
    console.log(JSON.stringify({ applied: apply, reviewSha256: digest, name: form.name, slug: form.slug,
      fieldCount: form.fields.length, questionsAdded: 0, active: form.is_active,
      traineeScheduleVerified: true, affiliations: 'primary organisation and departments' }));
  } catch (e) { await db.query('ROLLBACK'); throw e; }
  finally { await db.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
