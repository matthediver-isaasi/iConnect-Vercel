import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const migration = fs.readFileSync(
  new URL('../../supabase/migrations/20260930_bnms_department_card_organisation_column.sql', import.meta.url),
  'utf8',
);
const pickerMigration = fs.readFileSync(
  new URL('../../supabase/migrations/20261005_bnms_department_picker_organisation_context.sql', import.meta.url),
  'utf8',
);

test('BNMS Department card migration preserves unrelated columns and reconciles only Organisation', () => {
  assert.match(migration, /jsonb_array_elements\(v_existing_columns\) WITH ORDINALITY/);
  assert.match(migration, /jsonb_agg\(existing_column ORDER BY ordinal\)/);
  assert.match(migration, /existing_column->>'relationship_definition_id' = v_department_organisation::text/);
  assert.match(migration, /existing_column->>'side' = 'source'/);
  assert.match(migration, /v_columns := v_columns \|\| jsonb_build_array/);
  assert.doesNotMatch(
    migration,
    /v_columns\s*:=\s*jsonb_build_array\s*\(jsonb_build_object/,
    'the migration must not replace the complete source column list',
  );
});

test('BNMS Department picker migration uses the owning Organisation relationship from the Department source side', () => {
  assert.match(pickerMigration, /relationship_key = 'members'[\s\S]*source_kind = 'custom_object'[\s\S]*target_kind = 'member'/);
  assert.match(pickerMigration, /relationship_key = 'organisation'[\s\S]*source_kind = 'custom_object'[\s\S]*target_kind = 'organization'/);
  assert.match(pickerMigration, /'\{source_column\}'[\s\S]*v_source_column/);
  assert.match(pickerMigration, /'relationship_definition_id', v_department_organisation::text/);
  assert.match(pickerMigration, /'side', 'source'/);
  assert.match(pickerMigration, /'label', 'Organisation'/);
});

test('BNMS Department picker migration preserves sibling configuration and is replay-safe', () => {
  assert.match(pickerMigration, /v_picker_context := COALESCE\(v_existing_configuration->'picker_context', '\{\}'::jsonb\)/);
  assert.match(pickerMigration, /jsonb_set\(v_picker_context, '\{source_column\}', v_source_column, true\)/);
  assert.match(pickerMigration, /configuration IS DISTINCT FROM v_next_configuration/);
  assert.doesNotMatch(pickerMigration, /SET configuration\s*=\s*jsonb_build_object/);
});

test('BNMS Department picker migration fails closed for absent, ambiguous, or malformed models', () => {
  assert.match(pickerMigration, /SELECT id INTO STRICT v_department_object/);
  assert.match(pickerMigration, /INTO STRICT v_member_departments, v_existing_configuration/);
  assert.match(pickerMigration, /SELECT id INTO STRICT v_department_organisation/);
  assert.match(pickerMigration, /WHEN NO_DATA_FOUND[\s\S]*was not found/);
  assert.match(pickerMigration, /WHEN TOO_MANY_ROWS[\s\S]*is ambiguous/);
  assert.match(pickerMigration, /configuration must be a JSON object/);
  assert.match(pickerMigration, /picker_context must be a JSON object/);
  assert.doesNotMatch(pickerMigration, /RAISE NOTICE|RETURN;/);
});