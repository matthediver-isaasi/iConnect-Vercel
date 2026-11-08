import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { connectDestination } from './lib/member-index-destination.mjs';
import { validateMemberAffiliationConfig } from '../api/_lib/formMemberAffiliationConfig.js';

const tenant = 'ff2df806-b321-4254-b651-3af11fccf1db';
const targetId = 'e86b2a16-e5bc-4c18-9329-6862cb2a2a4b';
const orgField = 'field_1788075690796';
const alias = 'field_1788942217508';
const changedKeys = ['fields', 'visibility_rules', 'entity_pipelines', 'member_affiliation_enabled'];
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function buildAssociateAffiliations(target) {
  assert.equal(target.id, targetId);
  assert.equal(target.tenant_id, tenant);
  assert.equal(target.require_authentication, true);
  assert.equal(target.prefill_source, 'member');
  assert.equal(target.member_affiliation_enabled, false);
  const form = structuredClone(target);
  const field = form.fields.find(f => f.id === orgField);
  assert.equal(field.type, 'organisation_dropdown');
  // This form has no trust/group question; its legacy parent points to a
  // field that does not exist. Keep its own country/type selection filters.
  if (field.parent_field_id && !form.fields.some(f => f.id === field.parent_field_id)) {
    delete field.parent_field_id;
    delete field.parent_field_scope;
  }
  // The affiliation transaction owns organisation changes. Remove the obsolete
  // hidden-name assignment used by the former organisation-creation pipeline.
  form.visibility_rules = form.visibility_rules.map(r => ({ ...r,
    actions: r.actions.filter(a => a.target_field_id !== alias) }))
    .filter(r => r.actions.length);
  form.entity_pipelines.organisations = [];
  for (const member of form.entity_pipelines.members) delete member.login_enabled;
  form.member_affiliation_enabled = true;
  const config = {
    version: 1, enabled: true,
    primaryOrganizationFieldIds: [orgField],
    prefillAffiliationQuestions: true,
    countryFieldId: 'field_1786371332409',
    organizationCountryFieldId: '4f8b5c47-f074-4d15-96fd-0a44f81725eb',
  };
  assert.deepEqual(form.fields.map(f => f.id), target.fields.map(f => f.id), 'Do not add or remove questions');
  for (const field of target.fields.filter(f => f.id !== orgField)) {
    assert.deepEqual(form.fields.find(f => f.id === field.id), field);
  }
  for (const key of Object.keys(target)) if (!changedKeys.includes(key)) assert.deepEqual(form[key], target[key], key);
  return { form, config };
}

async function main() {
  const apply = process.argv.includes('--apply');
  const db = await connectDestination();
  try {
    await db.query(apply ? 'BEGIN' : 'BEGIN READ ONLY');
    await db.query("SET LOCAL lock_timeout='5s'");
    const forms = (await db.query(`select to_jsonb(f) as row from form f
      where tenant_id=$1 and id=any($2::uuid[]) order by id${apply ? ' for update' : ''}`,
    [tenant, [targetId, 'ce768ba0-ece0-406f-93f0-c0931605185f',
      '643ee195-0542-46a9-9464-018dd38b3019', '824f5fda-7415-47f0-81a1-8bd85e589587']])).rows.map(r => r.row);
    const target = forms.find(f => f.id === targetId);
    const existing = (await db.query('select config from form_member_affiliation_config where tenant_id=$1 and form_id=$2',
      [tenant, targetId])).rows;
    assert.equal(existing.length, 0, 'Configuration already exists; do not overwrite');
    const digest = hash(target);
    const { form, config } = buildAssociateAffiliations(target);
    const validated = validateMemberAffiliationConfig(form, config, { complete: true, objects: [], relationships: [], fields: {} });
    if (apply) {
      assert.ok(process.argv.includes(`--review-sha256=${digest}`), 'Live configuration changed or review hash missing');
      await mkdir('generated-artifacts/form-config-backups', { recursive: true });
      const path = `generated-artifacts/form-config-backups/associate-primary-only-${digest}.json`;
      const backup = JSON.stringify({ tenant, formId: targetId,
        before: Object.fromEntries(changedKeys.map(k => [k, target[k]])), configBefore: null }, null, 2);
      try { await writeFile(path, backup, { mode: 0o600, flag: 'wx' }); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        assert.equal(await readFile(path, 'utf8'), backup);
      }
      // The marker trigger derives its value from the configuration: insert
      // configuration first, then update the form inside the same transaction.
      await db.query('insert into form_member_affiliation_config(tenant_id,form_id,config) values($1,$2,$3::jsonb)',
        [tenant, targetId, JSON.stringify(validated)]);
      await db.query(`update form set fields=$1::jsonb,visibility_rules=$2::jsonb,
        entity_pipelines=$3::jsonb,member_affiliation_enabled=true where id=$4 and tenant_id=$5`,
      [JSON.stringify(form.fields), JSON.stringify(form.visibility_rules), JSON.stringify(form.entity_pipelines), targetId, tenant]);
      const saved = (await db.query('select to_jsonb(f) as row from form f where id=$1', [targetId])).rows[0].row;
      assert.deepEqual(saved, form);
      for (const other of forms.filter(f => f.id !== targetId)) {
        assert.deepEqual((await db.query('select to_jsonb(f) as row from form f where id=$1', [other.id])).rows[0].row, other);
      }
      assert.deepEqual((await db.query('select config from form_member_affiliation_config where form_id=$1', [targetId])).rows[0].config, validated);
      await db.query('COMMIT');
    } else await db.query('ROLLBACK');
    console.log(JSON.stringify({ applied: apply, reviewSha256: digest, fieldCount: form.fields.length,
      questionsAdded: 0, departmentMappings: 0, groupMappings: 0,
      paymentUnchanged: true, otherFormsUnchanged: true, compatibilityValidated: true }));
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { await db.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
