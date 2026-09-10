import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const sql = await readFile(new URL('./20261010_bnms_organisation_department_summary.sql', import.meta.url), 'utf8');

test('summary setup validates the pinned tenant schema and uses ordinary version-two settings', () => {
  assert.match(sql, /INTO STRICT v_field/);
  assert.match(sql, /relationship_key = 'organisation' AND cardinality = 'many_to_one'/);
  assert.match(sql, /relationship_key = 'members' AND cardinality = 'many_to_many'/);
  assert.match(sql, /'version', 2, 'start_object_id'/);
  assert.match(sql, /'start_endpoint', jsonb_build_object\('kind', 'organization'\)/);
  assert.match(sql, /'include_empty', true/);
  assert.match(sql, /'empty_label', 'No departments'/);
  assert.match(sql, /'kind', 'count_distinct'[\s\S]*v_members::text, 'from_side', 'source'/);
  assert.match(sql, /'label', 'Department member count'/);
});

test('summary setup appends separately without changing source data or existing reports', () => {
  assert.match(sql, /bnms_organisation_department_summary/);
  assert.doesNotMatch(sql, /UPDATE public\.(?:member|organization|custom_object_record|custom_object_relationship)\b/i);
  assert.match(sql, /pg_advisory_xact_lock/);
  assert.match(sql, /FOR UPDATE/);
  assert.match(sql, /WHERE r->>'id' = v_id[\s\S]*RETURN;/);
  assert.match(sql, /COALESCE\(v_existing->'reports', '\[\]'::jsonb\)\s*\|\| jsonb_build_array\(v_report\)/);
});