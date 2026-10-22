#!/usr/bin/env node
// Destination-only, read-only by default. Uses the current report, never a
// historical replacement. --apply requires a reviewed settings snapshot digest.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';
import { destinationTarget } from './apply-custom-object-relationship-deleted-members-migration.mjs';
import { tenantId, objectId, reportId, organizationRelationship } from './lib/bnms-responder-report.mjs';
import { createCustomObjectService } from '../api/_lib/customObjectService.js';

const regionId = '91e58f93-f78f-465e-948b-c4808aecd89c';
const args = process.argv.slice(2);
assert.ok(args.every(arg => arg === '--apply' || /^--expected-sha256=[a-f0-9]{64}$/.test(arg)), 'Unknown argument');
const apply = args.includes('--apply');
if (apply) {
  // A fork's source is not rollout evidence. Do not save a definition that the
  // currently served report builder would reject on reopen.
  const origin = 'https://bnms.dev.iconn.app';
  const page = await fetch(`${origin}/CustomObjectsAdmin/${objectId}`, { cache: 'no-store' });
  assert.ok(page.ok, 'BNMS page unavailable; no settings changed');
  const html = await page.text();
  const entry = html.match(/src="(\/assets\/index-[^"]+\.js)"/)?.[1];
  assert.ok(entry, 'Cannot identify served application bundle');
  const entryResponse = await fetch(`${origin}${entry}`, { cache: 'no-store' });
  assert.ok(entryResponse.ok, 'Application bundle unavailable');
  const source = await entryResponse.text();
  const chunk = source.match(/(?:assets\/|\.\/)(CustomObjectsAdmin-[a-zA-Z0-9_-]+\.js)/)?.[1];
  assert.ok(chunk, 'Cannot identify served report builder');
  const builderResponse = await fetch(`${origin}/assets/${chunk}`, { cache: 'no-store' });
  assert.ok(builderResponse.ok, 'Report builder unavailable');
  const builder = await builderResponse.text();
  assert.ok(builder.includes('report-organization-fields') && builder.includes('preference_field_id'),
    'BNMS still serves a report builder without organisation preference support; no settings changed');
}
const target = destinationTarget(process.env);
const ca = await fetch('https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt');
assert.ok(ca.ok, 'Provider CA unavailable');
const sql = new pg.Client({ connectionString: target.toString(),
  ssl: { rejectUnauthorized: true, ca: await ca.text(), servername: target.hostname } });
const db = createClient(process.env.DEST_SUPABASE_URL, process.env.DEST_SUPABASE_KEY,
  { auth: { persistSession: false } });
const service = createCustomObjectService({ db,
  context: { isAuthenticated: true, tenantId, tenantUserId: 'organisation-region-verification' }, isAdmin: true });
const key = `custom_object_reports_${objectId}`;
const digest = value => createHash('sha256').update(value).digest('hex');
async function preview(definition) {
  const rows = [];
  for (let page = 1; page < 1000; page++) {
    const result = await service.previewReport(objectId, { definition, page, pageSize: 50 });
    rows.push(...result.data);
    if (!result.has_more) return rows;
  }
  throw new Error('Unexpected report pagination');
}
try {
  await sql.connect();
  const { rows } = await sql.query('SELECT id, setting_value FROM public.system_settings WHERE tenant_id=$1 AND setting_key=$2', [tenantId, key]);
  assert.equal(rows.length, 1, 'Ambiguous report settings');
  const setting = rows[0];
  const sha256 = digest(setting.setting_value);
  const settings = JSON.parse(setting.setting_value);
  const reports = settings.reports.filter(report => report.id === reportId);
  assert.equal(reports.length, 1, 'Ambiguous report identity');
  const report = reports[0];
  assert.equal(report.name, 'Department member count with survey responder');
  const { rows: fields } = await sql.query(`SELECT id, name, label, field_type, entity_scope, is_active
    FROM public.preference_field WHERE tenant_id=$1 AND entity_scope='organization' AND (name='region' OR label='Region')`, [tenantId]);
  assert.deepEqual(fields, [{ id: regionId, name: 'region', label: 'Region',
    field_type: 'dropdown', entity_scope: 'organization', is_active: true }], 'Region metadata changed or ambiguous');
  const orgPath = [{ relationship_definition_id: organizationRelationship, from_side: 'source' }];
  const nameIndices = report.config.columns.flatMap((column, index) =>
    column.kind === 'field' && column.field === 'name'
    && JSON.stringify(column.path) === JSON.stringify(orgPath) ? [index] : []);
  assert.equal(nameIndices.length, 1, 'Organisation Name traversal changed or ambiguous');
  const nameIndex = nameIndices[0];
  const next = structuredClone(report);
  const existing = next.config.columns.filter(column => column.preference_field_id === regionId);
  assert.ok(existing.length <= 1, 'Duplicate Region columns');
  if (!existing.length) {
    next.version = (Number(next.version) || 1) + 1;
    next.config.columns.splice(nameIndex + 1, 0, {
      id: `organization:preference:${regionId}`, kind: 'field',
      path: structuredClone(report.config.columns[nameIndex].path),
      preference_field_id: regionId, label: 'Organisation Region',
    });
  } else {
    assert.equal(next.config.columns[nameIndex + 1], existing[0], 'Region must follow Organisation Name');
    assert.deepEqual(existing[0].path, orgPath);
    assert.equal(existing[0].label, 'Organisation Region');
  }
  await mkdir('generated-artifacts/organisation-region', { recursive: true });
  await writeFile(`generated-artifacts/organisation-region/before-${sha256}.json`,
    JSON.stringify({ target: 'lvmzliemqnieeoruhkik', ...setting }, null, 2), { mode: 0o600 });
  const before = await preview(report.config);
  const after = await preview(next.config);
  assert.equal(after.length, before.length, 'Row membership changed');
  for (let index = 0; index < before.length; index++) {
    assert.equal(after[index].id, before[index].id, 'Row identity/order changed');
    const values = [...after[index].values];
    if (!existing.length) values.splice(nameIndex + 1, 1);
    assert.deepEqual(values, before[index].values, 'Existing projection/count/responder changed');
  }
  // Independently verify the region source without persisting any personal data.
  const { rows: expected } = await sql.query(`SELECT d.id,
      coalesce(string_agg(DISTINCT nullif(v.value,''), '; ' ORDER BY nullif(v.value,'')), '') AS region
    FROM public.custom_object_record d
    LEFT JOIN public.custom_object_relationship e ON e.tenant_id=d.tenant_id AND e.source_record_id=d.id
      AND e.relationship_definition_id=$3 AND e.archived_at IS NULL
    LEFT JOIN public.organization o ON o.id=e.target_record_id AND o.tenant_id=d.tenant_id
    LEFT JOIN public.organization_preference_value v ON v.organization_id=o.id AND v.field_id=$4
    WHERE d.tenant_id=$1 AND d.custom_object_id=$2 AND d.archived_at IS NULL GROUP BY d.id`,
  [tenantId, objectId, organizationRelationship, regionId]);
  const regionByDepartment = new Map(expected.map(row => [row.id, row.region]));
  for (const row of after) assert.equal(row.values[nameIndex + 1], regionByDepartment.get(row.id), 'Region source differs');
  const nextSettings = { ...settings, reports: settings.reports.map(item => item.id === reportId ? next : item) };
  if (apply && !existing.length) {
    assert.ok(args.includes(`--expected-sha256=${sha256}`), 'Fresh reviewed snapshot digest required');
    await sql.query('BEGIN');
    await sql.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s'");
    const changed = await sql.query(`UPDATE public.system_settings SET setting_value=$1
      WHERE id=$2 AND tenant_id=$3 AND setting_key=$4 AND setting_value=$5 RETURNING setting_value`,
    [JSON.stringify(nextSettings), setting.id, tenantId, key, setting.setting_value]);
    assert.equal(changed.rowCount, 1, 'Concurrent settings change; no overwrite');
    assert.deepEqual(JSON.parse(changed.rows[0].setting_value), nextSettings);
    await sql.query('COMMIT');
  }
  console.log(JSON.stringify({ target: 'DEST lvmzliemqnieeoruhkik', reportId, regionId,
    mode: apply ? 'apply' : 'read-only', sha256, previousVersion: report.version, nextVersion: next.version,
    rows: after.length, nonBlankRegions: after.filter(row => row.values[nameIndex + 1] !== '').length,
    unchangedExistingValues: true, alreadyApplied: Boolean(existing.length), migrations: 0 }, null, 2));
} catch (error) {
  await sql.query('ROLLBACK').catch(() => {});
  throw error;
} finally {
  await sql.end();
}
