import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { connectDestination } from './lib/member-index-destination.mjs';
import { validateMemberAffiliationConfig } from '../api/_lib/formMemberAffiliationConfig.js';

export const SOURCE = '7a173155-7932-4f80-bac3-12644920b9a0';
export const TARGET = '816a5f51-61bd-4733-a42f-118c5136fa68';
const TENANT = 'ff2df806-b321-4254-b651-3af11fccf1db';
const UNIVERSITY = 'field_1787065791684';
const ALIAS = 'field_1788939115747';
const CLASS = '87f120ff-92e6-4d52-944b-9ba9d7b1fac0';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function buildStudentRenewal(source) {
  assert.equal(source.id, SOURCE);
  assert.equal(source.tenant_id, TENANT);
  assert.equal(source.archived_at, null);
  assert.ok(!source.fields.some(f => ['payment', 'membership_payment'].includes(f.type)));
  assert.equal(source.fields.find(f => f.id === UNIVERSITY)?.type, 'organisation_dropdown');
  const form = structuredClone(source);
  Object.assign(form, {
    id: TARGET, name: 'Student renew', slug: 'student-renew', is_active: false,
    submission_count: 0, survey_audit_log: [],
    require_authentication: true, prefill_source: 'member', prefill_source_field_id: null,
    mutation_access_policy: { version: 1, mode: 'authenticated_owner' },
    due_diligence_required: false, member_affiliation_enabled: true,
  });
  form.uniqueness_checks = form.uniqueness_checks.filter(c => c.target_field !== 'member.email');
  const member = form.entity_pipelines.members.find(p => p.isPrimary);
  assert.equal(member.mappings.find(m => m.target_field === CLASS)?.static_value, 'Student');
  delete member.login_enabled;
  member.related_records = [];
  member.mappings = member.mappings.filter(m => !(m.source_type === 'static' &&
    (m.static_value === 'Full application received' || m.target_field === 'show_in_directory'
      || m.target_type === 'communication')));
  form.entity_pipelines.organisations = [];
  for (const mapping of member.mappings) {
    const field = form.fields.find(f => f.id === mapping.source_field_id);
    if (!field || field.prefill_field || mapping.source_type !== 'field') continue;
    if (['text', 'textarea', 'email', 'tel', 'select', 'radio', 'date', 'country'].includes(field.type)) {
      if (mapping.target_type === 'core') field.prefill_field = `member:${mapping.target_field}`;
      if (mapping.target_type === 'custom') field.prefill_field = `member_custom:${mapping.target_field}`;
    }
  }
  form.visibility_rules = form.visibility_rules.map(rule => {
    const copy = structuredClone(rule);
    copy.actions = copy.actions.filter(a => a.target_field_id !== ALIAS);
    for (const action of copy.actions) {
      if (action.set_value_source === 'prefill' && action.target_field_id === 'field_1788273087721') {
        action.set_value_prefill_source_field_id = UNIVERSITY;
      }
    }
    return copy;
  }).filter(r => r.actions.length);
  // University only: no authority over trusts, departments, or secondary sites.
  // Study country comes from the member's saved answer, not university location.
  const config = { version: 1, enabled: true, primaryOrganizationFieldIds: [UNIVERSITY] };
  assert.deepEqual(form.fields.map(f => [f.id, f.type, f.label, f.page_id]),
    source.fields.map(f => [f.id, f.type, f.label, f.page_id]));
  assert.deepEqual(form.pages, source.pages);
  return { form, config };
}

async function main() {
  const apply = process.argv.includes('--apply');
  const db = await connectDestination();
  try {
    await db.query(apply ? 'BEGIN' : 'BEGIN READ ONLY');
    await db.query("SET LOCAL lock_timeout='5s'");
    const source = (await db.query(`select to_jsonb(f) row from form f where tenant_id=$1 and id=$2${apply ? ' for share' : ''}`,
      [TENANT, SOURCE])).rows[0]?.row;
    assert.ok(source);
    assert.equal((await db.query('select id from form where tenant_id=$1 and (id=$2 or slug=$3)',
      [TENANT, TARGET, 'student-renew'])).rowCount, 0, 'Destination already exists; do not duplicate');
    const { form, config } = buildStudentRenewal(source);
    const validated = validateMemberAffiliationConfig(form, config, { complete: true, objects: [], fields: {}, relationships: [] });
    const digest = hash(source);
    if (apply) {
      assert.ok(process.argv.includes(`--review-sha256=${digest}`), 'Source changed or missing review hash');
      await mkdir('generated-artifacts/form-config-backups', { recursive: true });
      await writeFile(`generated-artifacts/form-config-backups/student-renewal-source-${digest}.json`,
        JSON.stringify({ sourceId: SOURCE, targetId: TARGET, source }, null, 2), { mode: 0o600, flag: 'wx' });
      const columns = Object.keys(form);
      assert.ok(columns.every(k => /^[a-z_]+$/.test(k)));
      const quoted = columns.map(k => `"${k}"`).join(',');
      // Explicit source columns avoid inheriting submissions or inventing columns.
      await db.query(`insert into form (${quoted}) select ${quoted} from jsonb_populate_record(null::public.form,$1::jsonb)`,
        [JSON.stringify({ ...form, member_affiliation_enabled: false })]);
      await db.query('insert into form_member_affiliation_config(tenant_id,form_id,config) values($1,$2,$3::jsonb)',
        [TENANT, TARGET, JSON.stringify(validated)]);
      await db.query('update form set member_affiliation_enabled=true where tenant_id=$1 and id=$2', [TENANT, TARGET]);
      assert.deepEqual((await db.query('select to_jsonb(f) row from form f where id=$1', [TARGET])).rows[0].row, form);
      assert.deepEqual((await db.query('select to_jsonb(f) row from form f where id=$1', [SOURCE])).rows[0].row, source);
      assert.deepEqual((await db.query('select config from form_member_affiliation_config where form_id=$1', [TARGET])).rows[0].config, validated);
      await db.query('COMMIT');
    } else await db.query('ROLLBACK');
    console.log(JSON.stringify({ applied: apply, reviewSha256: digest, id: TARGET, name: form.name,
      slug: form.slug, active: form.is_active, fieldCount: form.fields.length,
      questionsAdded: 0, paymentFields: 0, sourceUnchanged: true }));
  } catch (e) { await db.query('ROLLBACK'); throw e; }
  finally { await db.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
