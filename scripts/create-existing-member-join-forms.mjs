import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { connectDestination } from './lib/member-index-destination.mjs';
import { assessFormMutationAccess } from '../shared/formMutationContract.js';

export const TENANT = 'ff2df806-b321-4254-b651-3af11fccf1db';
export const COPIES = [
  ['6880a70a-8643-4fcc-a5b9-0af603f00b40', '518d4626-1c5c-4dff-85e3-0e9743b01563'],
  ['ebf2e9ae-92a2-4f1e-a91b-fb4f97ad277a', 'edd2ac75-e9aa-46e1-a971-82859fe96af5'],
  ['ce768ba0-ece0-406f-93f0-c0931605185f', 'e50e9180-2392-44c6-9465-b95cae23eb8a'],
  ['0bfa31b0-618f-4498-94bf-a9dbffd76165', 'cba644ba-2704-41cc-b7f0-8fce3bb0bdd2'],
  ['7a173155-7932-4f80-bac3-12644920b9a0', '84df23c7-b148-45d7-8b57-c2e194c57ceb'],
];
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const scalarTypes = new Set(['text', 'textarea', 'email', 'tel', 'number', 'date', 'country', 'radio', 'select', 'dropdown', 'checkbox']);

export function buildExistingMemberJoin(source, targetId) {
  assert.equal(source.tenant_id, TENANT);
  assert.equal(source.archived_at, null);
  assert.equal(source.entity_pipelines?.members?.length, 1, 'Review multiple member pipelines before copying');
  assert.equal((source.additional_member_creations || []).length, 0);
  assert.equal(source.member_affiliation_enabled, false, 'Do not copy separately stored affiliation settings implicitly');
  const form = structuredClone(source);
  Object.assign(form, {
    id: targetId, name: `${source.name} for existing member`,
    slug: `${source.slug}-for-existing-member`, is_active: false,
    submission_count: 0, survey_audit_log: [], archived_at: null,
    require_authentication: true, prefill_source: 'member', prefill_source_field_id: null,
    mutation_access_policy: { version: 1, mode: 'authenticated_owner' },
  });
  // Signing in establishes ownership. An existing email is expected here.
  form.uniqueness_checks = (form.uniqueness_checks || []).filter(c => c.target_field !== 'member.email');
  const member = form.entity_pipelines.members[0];
  delete member.login_enabled;
  member.mappings = member.mappings.filter(m => !(m.source_type === 'static'
    && (m.target_type === 'communication' || (m.target_type === 'core'
      && ['show_in_directory', 'login_enabled'].includes(m.target_field)))));
  const calculatedFields = new Set((form.visibility_rules || []).flatMap(r => r.actions || [])
    .filter(a => a.action_type === 'set_value').map(a => a.target_field_id));
  for (const field of form.fields) {
    if (field.price_field_id) calculatedFields.add(field.price_field_id);
    if (field.membership_schedule_mapping?.source_field_id) calculatedFields.add(field.membership_schedule_mapping.source_field_id);
  }
  // Preserve each form's intended joining class, rather than prefill "Guest".
  if (member.role_assignment?.source_field_id) calculatedFields.add(member.role_assignment.source_field_id);
  for (const mapping of member.mappings) {
    if (mapping.source_type !== 'field' || calculatedFields.has(mapping.source_field_id)) continue;
    const field = form.fields.find(f => f.id === mapping.source_field_id);
    if (!field || field.prefill_field || !scalarTypes.has(field.type)) continue;
    if (mapping.target_type === 'core') field.prefill_field = `member:${mapping.target_field}`;
    if (mapping.target_type === 'custom') field.prefill_field = `member_custom:${mapping.target_field}`;
  }
  for (const rule of form.visibility_rules || []) for (const action of rule.actions || []) {
    // These rules previously inherited the selected organisation as their source.
    // Changing the overall prefill source must not turn them into member lookups.
    if (action.set_value_source === 'prefill' && !action.set_value_prefill_source_field_id) {
      assert.ok(source.prefill_source_field_id);
      action.set_value_prefill_source_field_id = source.prefill_source_field_id;
    }
    if (action.action_type === 'open_form') {
      const destination = COPIES.find(([id]) => id === action.destination_form_id);
      if (destination) action.destination_form_id = destination[1];
      // Trainee's existing junior route references the earlier version of
      // the junior joining form; the requested junior copy is its equivalent.
      if (action.destination_form_id === '8faff8a5-5671-41ef-a246-81810c34326d') {
        action.destination_form_id = COPIES[1][1];
      }
    }
  }
  assert.equal(assessFormMutationAccess(form).ok, true);
  assert.deepEqual(form.pages, source.pages);
  assert.deepEqual(form.fields.map(f => [f.id, f.type, f.label, f.page_id]),
    source.fields.map(f => [f.id, f.type, f.label, f.page_id]));
  assert.deepEqual(form.fields.filter(f => f.type.includes('payment')), source.fields.filter(f => f.type.includes('payment')));
  for (const key of ['due_diligence_required', 'is_due_diligence_enabled', 'date_membership_config_id',
    'submission_emails', 'structured_actions']) assert.deepEqual(form[key], source[key], key);
  return form;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const db = await connectDestination();
  try {
    await db.query(apply ? 'BEGIN' : 'BEGIN READ ONLY');
    await db.query("SET LOCAL lock_timeout='5s'");
    const sourceRows = (await db.query(`select to_jsonb(f) row from form f
      where tenant_id=$1 and id=any($2::uuid[]) order by id${apply ? ' for share' : ''}`,
    [TENANT, COPIES.map(([id]) => id)])).rows.map(r => r.row);
    assert.equal(sourceRows.length, 5);
    const forms = COPIES.map(([id, target]) => buildExistingMemberJoin(sourceRows.find(f => f.id === id), target));
    const review = digest(sourceRows);
    const existing = await db.query('select id from form where tenant_id=$1 and (id=any($2::uuid[]) or slug=any($3::text[]))',
      [TENANT, forms.map(f => f.id), forms.map(f => f.slug)]);
    assert.equal(existing.rowCount, 0, 'A copy already exists. Do not duplicate or overwrite it.');
    if (apply) {
      assert.ok(process.argv.includes(`--review-sha256=${review}`), 'Source changed or review hash missing');
      await mkdir('generated-artifacts/form-config-backups', { recursive: true });
      await writeFile(`generated-artifacts/form-config-backups/existing-member-join-${review}.json`,
        JSON.stringify({ sourceRows, copies: forms }, null, 2), { mode: 0o600, flag: 'wx' });
      for (const form of forms) {
        const columns = Object.keys(form);
        assert.ok(columns.every(k => /^[a-z_]+$/.test(k)));
        const sqlColumns = columns.map(k => `"${k}"`).join(',');
        await db.query(`insert into form (${sqlColumns})
          select ${sqlColumns} from jsonb_populate_record(null::public.form,$1::jsonb)`, [JSON.stringify(form)]);
        assert.deepEqual((await db.query('select to_jsonb(f) row from form f where id=$1', [form.id])).rows[0].row, form);
      }
      for (const source of sourceRows) assert.deepEqual(
        (await db.query('select to_jsonb(f) row from form f where id=$1', [source.id])).rows[0].row, source);
      await db.query('COMMIT');
    } else await db.query('ROLLBACK');
    console.log(JSON.stringify({ applied: apply, reviewSha256: review,
      copies: forms.map(f => ({ id: f.id, name: f.name, slug: f.slug, active: f.is_active,
        fields: f.fields.length, prefilledFields: f.fields.filter(x => x.prefill_field).length,
        dueDiligencePreserved: f.due_diligence_required })) }, null, 2));
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { await db.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
