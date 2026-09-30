/**
 * Static source-inspection tests only.  They never connect to PostgreSQL,
 * interpolate a manifest, execute SQL, or prove that a future approved install
 * will succeed.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const path = new URL('./import.sql.template', import.meta.url);
const sql = readFileSync(path, 'utf8');

test('template remains review-only and has one renderer token', () => {
  assert.match(sql, /REVIEW-ONLY ARTIFACT/);
  assert.match(sql, /DO NOT INSTALL OR INVOKE WITHOUT A SEPARATE/);
  assert.equal((sql.match(/__BNMS_MANIFEST_JSON__/g) || []).length, 1);
  assert.match(sql, /v_manifest_text text := \$manifest\$__BNMS_MANIFEST_JSON__\$manifest\$;/);
  assert.match(sql, /v_manifest jsonb := v_manifest_text::jsonb;/);
  assert.match(sql, /identical compact manifest\.json bytes, with no trailing newline/);
});

test('function is parameterless, guarded, transactional, and service-role-only', () => {
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.import_bnms_workforce_occurrences\(\)/);
  assert.match(sql, /SECURITY DEFINER\s+SET search_path = public\s+SET timezone = 'UTC'/);
  assert.match(sql, /current_setting\('bnms\.final_import_approval', true\) IS DISTINCT FROM v_sha \|\| ':' \|\| encode\(\s+pg_catalog\.sha256\(convert_to\(v_manifest_text, 'UTF8'\)\), 'hex'\)/);
  assert.match(sql, /SET LOCAL lock_timeout = '10s'/);
  assert.match(sql, /future approved invoke script must SET LOCAL statement_timeout/i);
  assert.doesNotMatch(sql, /\n\s*SET LOCAL statement_timeout/);
  assert.doesNotMatch(sql, /session_user|request\.jwt\.claim\.role/);
  assert.match(sql, /pg_advisory_xact_lock/);
  assert.match(sql, /LOCK TABLE public\.custom_object_record, public\.custom_object_relationship,/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.import_bnms_workforce_occurrences\(\) FROM PUBLIC, anon, authenticated/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.import_bnms_workforce_occurrences\(\) TO service_role/);
});

test('contract pins all occurrence counts, identity, canonical values, and no vacant WTE', () => {
  for (const required of ['<> 136', '<> 1242', '<> 1378', 'occurrence_identity',
    'format(\'["%s","%s","%s",%s]\'', 'pg_catalog.sha256(convert_to(', "data ? 'vacant_wte'",
    "o #>> '{}' = r.data->>f.name", "o->>'value' = r.data->>f.name",
    '<> 1708.14', '<> 1141', '<> 101', '<> 84', '<> 216', '<> 132']) {
    assert.ok(sql.includes(required), `missing static contract: ${required}`);
  }
  for (const pin of ['ff2df806-b321-4254-b651-3af11fccf1db', 'bf123bdb-7227-4f45-b5f9-8344d0f65446',
    '931df885-c3b7-449a-b206-eef31fb9e883', 'cd1ebfd3-3e16-4091-be5a-99992d926f2f',
    'b0c618501cf5af9073d074d6e0474cd772b0978437b3fdab55ff1a66390bf746']) {
    assert.ok(sql.includes(pin), `missing literal pin: ${pin}`);
  }
  assert.doesNotMatch(sql, /\bdigest\(/);
  assert.doesNotMatch(sql, /create_custom_object_record_with_relationships|import_pinned_workforce_survey/);
  assert.match(sql, /INSERT INTO public\.custom_object_record/);
  assert.match(sql, /INSERT INTO public\.custom_object_relationship/);
});

test('metadata, baseline, historical-overlap, and immutable ledgers fail closed', () => {
  for (const required of ['metadata,objects', 'metadata,fields', 'metadata,definitions',
    'baseline,records', 'baseline,edges', 'live metadata drifted',
    'first import refuses existing active or archived Department\/year overlap or partial ledger',
    'changed manifest\/file is permanently blocked', 'ledger is partial, archived, mutated, or has extra incident edges',
    "d.configuration <> '{}'::jsonb", 'bnms_workforce_import_runs', 'bnms_workforce_import_surveys', 'bnms_workforce_import_occurrences']) {
    assert.ok(sql.includes(required), `missing static safeguard: ${required}`);
  }
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /FOR ALL TO service_role USING \(true\) WITH CHECK \(true\)/);
  assert.match(sql, /LEFT JOIN public\.bnms_workforce_import_surveys s/);
  assert.match(sql, /o\.survey_id IS DISTINCT FROM s\.survey_id/);
  assert.match(sql, /CREATE TEMP TABLE pg_temp\.bnms_rows/);
  assert.equal((sql.match(/e\.field_values IS DISTINCT FROM '\{\}'::jsonb/g) || []).length, 2);
  assert.doesNotMatch(sql, /\bFROM bnms_rows\b|\bJOIN bnms_rows\b|\bFROM bnms_surveys\b|\bJOIN bnms_surveys\b/);
});