import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { connectDestination } from './annual-meeting-destination.mjs';
import { profileFormEligibility } from '../api/_lib/profileAffiliationForms.js';
const apply = process.argv.includes('--apply');
const text = await readFile('docs/profile-affiliation-form-staging.json', 'utf8');
const manifest = JSON.parse(text);
const digest = createHash('sha256').update(text).digest('hex');
if (apply && !process.argv.includes(`--manifest-sha256=${digest}`)) {
  throw new Error(`Explicit reviewed manifest hash required: --manifest-sha256=${digest}`);
}
assert.equal(manifest.tenantId, 'ff2df806-b321-4254-b651-3af11fccf1db');
assert.equal(manifest.form.is_active, false);
assert.equal(manifest.config.purpose, 'profile');
assert.equal(manifest.config.unknownOrganizationId, '7f16328d-e692-4671-873a-453464071eef');
assert.equal(profileFormEligibility({ ...manifest.form, member_affiliation_enabled: true }, manifest.config), null);
const db = await connectDestination();
try {
  await db.query(apply ? 'BEGIN' : 'BEGIN READ ONLY');
  await db.query("SET LOCAL lock_timeout='5s'");
  const { rows: [source] } = await db.query(`SELECT id,pages,fields,visibility_rules,entity_pipelines,structured_actions
    FROM form WHERE id=$1 AND tenant_id=$2${apply ? ' FOR SHARE' : ''}`, [manifest.sourceFormId, manifest.tenantId]);
  assert.ok(source, 'Source unavailable');
  assert.equal(createHash('sha256').update(JSON.stringify(source)).digest('hex'), manifest.sourceSha256,
    'Source changed since extraction; prepare and review a new manifest');
  const { rows: definitions } = await db.query(`SELECT id,source_kind,target_kind,source_custom_object_id,target_custom_object_id,status
    FROM custom_object_relationship_definition WHERE tenant_id=$1 AND id=ANY($2::uuid[]) ORDER BY id${apply ? ' FOR SHARE' : ''}`,
  [manifest.tenantId, manifest.definitions.map(d => d.id)]);
  assert.deepEqual(definitions, [...manifest.definitions].sort((a, b) => a.id.localeCompare(b.id)));
  const { rows: [fallback] } = await db.query('SELECT id,name FROM organization WHERE tenant_id=$1 AND id=$2',
    [manifest.tenantId, manifest.config.unknownOrganizationId]);
  assert.deepEqual(fallback, manifest.fallback);
  const { rows: existing } = await db.query('SELECT id,is_active FROM form WHERE tenant_id=$1 AND (id=$2 OR slug=$3)',
    [manifest.tenantId, manifest.form.id, manifest.form.slug]);
  if (existing.length) {
    assert.equal(existing.length, 1);
    assert.equal(existing[0].id, manifest.form.id, 'Slug already belongs to another form');
    console.log(JSON.stringify({ alreadyInstalled: true, formId: manifest.form.id, liveWrites: 0 }));
  } else if (apply) {
    assert.ok((await db.query("SELECT to_regprocedure('public.profile_form_affiliation_apply(uuid,uuid,uuid,uuid[],uuid[],uuid,jsonb)') AS installed")).rows[0].installed,
      'Install and verify the profile affiliation migration first');
    const form = { ...manifest.form, tenant_id: manifest.tenantId };
    const entries = Object.entries(form);
    await db.query(`INSERT INTO form(${entries.map(([key]) => `"${key}"`).join(',')})
      VALUES(${entries.map((_, i) => `$${i + 1}`).join(',')})`,
    entries.map(([, value]) => value && typeof value === 'object' ? JSON.stringify(value) : value));
    await db.query('INSERT INTO form_member_affiliation_config(tenant_id,form_id,config) VALUES($1,$2,$3::jsonb)',
      [manifest.tenantId, manifest.form.id, JSON.stringify(manifest.config)]);
    await db.query('UPDATE form SET member_affiliation_enabled=true WHERE tenant_id=$1 AND id=$2',
      [manifest.tenantId, manifest.form.id]);
    console.log(JSON.stringify({ draftInstalled: true, formId: manifest.form.id, published: false, routingEnabled: false }));
  } else {
    console.log(JSON.stringify({ preflight: true, manifestSha256: digest, formId: manifest.form.id, liveWrites: 0 }));
  }
  await db.query(apply ? 'COMMIT' : 'ROLLBACK');
} catch (error) {
  await db.query('ROLLBACK');
  throw error;
} finally { await db.end(); }
