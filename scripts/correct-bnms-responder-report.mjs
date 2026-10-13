// Read-only by default. Explicit application changes one saved report, not data
// or schema. Restore requires the exact corrected snapshot, never a blind overwrite.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';
import { createCustomObjectService } from '../api/_lib/customObjectService.js';
import { destinationTarget } from './apply-custom-object-relationship-deleted-members-migration.mjs';
import {
  tenantId, objectId, reportId, organizationId, memberRelationship, organizationRelationship,
  originalReport, correctedReport, replaceAffectedReport,
} from './lib/bnms-responder-report.mjs';

const args = process.argv.slice(2);
assert.ok(args.every((arg) => ['--apply', '--restore'].includes(arg)), 'Unknown argument');
assert.ok(!(args.includes('--restore') && args.includes('--apply')), 'Choose apply or restore');
const writing = args.length > 0;
const target = destinationTarget(process.env);
const response = await fetch('https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt');
assert.ok(response.ok, 'Provider CA unavailable');
const client = new pg.Client({ connectionString: target.toString(),
  ssl: { rejectUnauthorized: true, ca: await response.text(), servername: target.hostname } });
const fixed = correctedReport(originalReport);
const key = `custom_object_reports_${objectId}`;
try {
  await client.connect();
  await client.query(writing ? 'BEGIN' : 'BEGIN READ ONLY');
  await client.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s'");
  const rows = (await client.query(`SELECT id, setting_value FROM public.system_settings
    WHERE tenant_id=$1 AND setting_key=$2 ${writing ? 'FOR UPDATE' : ''}`, [tenantId, key])).rows;
  assert.equal(rows.length, 1);
  const setting = rows[0];
  const settings = JSON.parse(setting.setting_value);
  const report = settings.reports.find((r) => r.id === reportId);
  assert.ok(report);
  assert.equal(settings.reports.filter((r) => r.id === reportId).length, 1, 'Ambiguous saved report');
  assert.deepEqual(report, report.version === originalReport.version ? originalReport : fixed,
    'Saved report differs from both inspected and corrected definitions');
  const evidence = (await client.query(`
    SELECT d.id, count(DISTINCT m.id)::integer AS member_count,
      count(DISTINCT m.id) FILTER (WHERE e.field_values->'survey_respondent'='true'::jsonb)::integer AS responders,
      ARRAY[
        md5(coalesce(string_agg(coalesce(m.first_name,''), '; ' ORDER BY m.id) FILTER (WHERE m.id IS NOT NULL AND e.field_values->'survey_respondent'='true'::jsonb),'')),
        md5(coalesce(string_agg(coalesce(m.last_name,''), '; ' ORDER BY m.id) FILTER (WHERE m.id IS NOT NULL AND e.field_values->'survey_respondent'='true'::jsonb),'')),
        md5(coalesce(string_agg(coalesce(m.email,''), '; ' ORDER BY m.id) FILTER (WHERE m.id IS NOT NULL AND e.field_values->'survey_respondent'='true'::jsonb),''))
      ] AS identity_hashes
    FROM public.custom_object_record d
    JOIN public.custom_object_relationship o ON o.source_record_id=d.id
      AND o.tenant_id=d.tenant_id AND o.relationship_definition_id=$3 AND o.archived_at IS NULL
    LEFT JOIN public.custom_object_relationship e ON e.source_record_id=d.id
      AND e.tenant_id=d.tenant_id AND e.relationship_definition_id=$4 AND e.archived_at IS NULL
    LEFT JOIN public.member m ON m.id=e.target_record_id AND m.tenant_id=d.tenant_id
      AND (m.email IS NULL OR m.email !~* '^deleted_.+@deleted[.]local$')
    WHERE d.tenant_id=$1 AND d.custom_object_id=$2 AND d.archived_at IS NULL
      AND o.target_record_id=$5 GROUP BY d.id`,
  [tenantId, objectId, organizationRelationship, memberRelationship, organizationId])).rows;
  assert.equal(evidence.length, 1, 'Reported Organisation no longer has exactly one Department');
  assert.equal(evidence[0].member_count, 4);
  // Run the actual current service against DEST; never print names or emails.
  const db = createClient(process.env.DEST_SUPABASE_URL, process.env.DEST_SUPABASE_KEY,
    { auth: { persistSession: false } });
  const service = createCustomObjectService({
    db, context: { isAuthenticated: true, tenantId, tenantUserId: 'read-only-report-verification' }, isAdmin: true,
  });
  async function verify(definition, expectedMatches) {
    let found;
    let rowCount = 0;
    for (let page = 1; ; page++) {
      const result = await service.previewReport(objectId, { definition, page, pageSize: 50 });
      rowCount += result.data.length;
      found ||= result.data.find((row) => row.id === evidence[0].id);
      if (!result.has_more) break;
      assert.ok(page < 1000, 'Unexpected pagination');
    }
    assert.ok(found, 'Department must remain visible');
    assert.equal(found.values[3], evidence[0].responders ? 'True' : 'False');
    assert.equal(found.values[7], 4);
    if (expectedMatches === 'designated') {
      assert.deepEqual(found.values.slice(4, 7).map((value) => createHash('md5').update(value).digest('hex')),
        evidence[0].identity_hashes, 'Service identities must agree with direct final-edge evidence');
    } else {
      for (const value of found.values.slice(4, 7)) assert.equal(value.split('; ').length, 4);
    }
    return { rowCount, memberCount: 4, responderIndicator: Boolean(evidence[0].responders),
      identitySlots: expectedMatches === 'designated' ? evidence[0].responders : 4 };
  }
  const before = await verify(report.config, report.version === originalReport.version ? 'all' : 'designated');
  const after = await verify(fixed.config, 'designated');
  if (writing) {
    const expected = args.includes('--restore') ? fixed : originalReport;
    const replacement = args.includes('--restore') ? originalReport : fixed;
    const next = replaceAffectedReport(settings, expected, replacement);
    const digest = createHash('sha256').update(setting.setting_value).digest('hex');
    await mkdir('generated-artifacts/department-responder-repair', { recursive: true });
    await writeFile(`generated-artifacts/department-responder-repair/${digest}.json`,
      JSON.stringify({ target: 'lvmzliemqnieeoruhkik', ...setting }, null, 2), { flag: 'wx', mode: 0o600 });
    const changed = await client.query(`UPDATE public.system_settings SET setting_value=$1
      WHERE id=$2 AND tenant_id=$3 AND setting_key=$4 AND setting_value=$5 RETURNING setting_value`,
    [JSON.stringify(next), setting.id, tenantId, key, setting.setting_value]);
    assert.equal(changed.rowCount, 1, 'Compare-before-write failed');
    assert.deepEqual(JSON.parse(changed.rows[0].setting_value), next);
  }
  await client.query('COMMIT');
  console.log(JSON.stringify({ target: 'lvmzliemqnieeoruhkik', mode: args[0] || 'read-only',
    reportId, evidence: evidence.map(({ identity_hashes, ...counts }) => counts),
    before, corrected: after, migrations: 0, relationshipWrites: 0 }, null, 2));
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  throw error;
} finally {
  await client.end();
}
