import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const sql = readFileSync(new URL('./import.sql.template', import.meta.url), 'utf8');
test('direct template is review-only, parameterless, service-only, and has one token', () => {
  assert.match(sql, /REVIEW-ONLY ARTIFACT/);
  assert.equal((sql.match(/__BNMS_DIRECT_MANIFEST_JSON__/g) || []).length, 1);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.import_bnms_workforce_direct_occurrences\(\)/);
  assert.match(sql, /SECURITY DEFINER\s+SET search_path = public\s+SET timezone = 'UTC'/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.import_bnms_workforce_direct_occurrences\(\) FROM PUBLIC, anon, authenticated/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.import_bnms_workforce_direct_occurrences\(\) TO service_role/);
  assert.match(sql, /bnms\.final_import_approval/);
});
test('direct template pins direct-only data, occurrence identity, locks, triggers, and replay', () => {
  for (const required of ['a422da51-6005-4831-a69e-bf284ff6f124', '<> 1242',
    "data ? 'row_name'", "data ? 'vacant_wte'", "t.tgenabled = 'D'",
    'pg_advisory_xact_lock', 'SHARE ROW EXCLUSIVE', 'occurrence_identity',
    `format('["%s","%s","%s",%s]'`, 'BNMS existing eight-row baseline changed',
    'permanently blocked', 'unprovenanced Row overlap', 'edgesCreated']) {
    assert.ok(sql.includes(required), `missing safeguard ${required}`);
  }
  assert.doesNotMatch(sql, /survey_name|row_name', v_/);
  assert.doesNotMatch(sql, /f\.archived_at/);
});
test('optional omitted fields are not rejected by type validation', () => {
  assert.match(sql, /WHERE \(r\.data \? f\.name\) AND jsonb_typeof\(r\.data->f\.name\) IS DISTINCT FROM 'number'/);
  assert.match(sql, /WHERE\s+\(r\.data \? f\.name\) AND \(jsonb_typeof\(r\.data->f\.name\) IS DISTINCT FROM 'string'/);
  assert.match(sql, /f\.is_required AND EXISTS[\s\S]*NOT \(r\.data \? f\.name\)/);
});
test('provenance is bound to its exact run and cannot be inserted by service role', () => {
  assert.match(sql, /FOREIGN KEY \(tenant_id, row_object_id, source_sha256\)\s+REFERENCES public\.bnms_workforce_direct_import_runs/);
  assert.match(sql, /GRANT SELECT ON TABLE public\.bnms_workforce_direct_import_runs/);
  assert.doesNotMatch(sql, /GRANT SELECT, INSERT ON TABLE/);
  assert.match(sql, /row_object_id=v_row_object\)<>\s*1242/);
  assert.match(sql, /source_sha256<>v_sha/);
  assert.match(sql, /row_object_id=v_row_object AND source_sha256=v_sha\)/);
});