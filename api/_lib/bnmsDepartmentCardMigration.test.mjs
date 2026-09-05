import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const migration = fs.readFileSync(
  new URL('../../supabase/migrations/20260930_bnms_department_card_organisation_column.sql', import.meta.url),
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