import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const sql = await readFile(
  new URL('./20261007_bnms_department_member_report.sql', import.meta.url),
  'utf8',
);

test('Department member report setup is pinned and validates live relationship schema', () => {
  assert.match(sql, /cd1ebfd3-3e16-4091-be5a-99992d926f2f/);
  assert.match(sql, /relationship_key = 'organisation'[\s\S]*cardinality = 'many_to_one'/);
  assert.match(sql, /relationship_key = 'members'[\s\S]*cardinality = 'many_to_many'/);
  assert.match(sql, /jsonb_array_elements[\s\S]*survey\.\*respond/i);
});

test('Department member report has the required ordered columns and edge-grain path', () => {
  const labels = [...sql.matchAll(/'label', '([^']+)'/g)].map((match) => match[1]);
  assert.deepEqual(labels.slice(-9), [
    'Organisation ID', 'Organisation Name', 'Department ID', 'Department Name',
    'Member ID', 'Member first name', 'Member last name', 'Member email',
    'department survey responder',
  ]);
  assert.match(sql, /'grain_path'[\s\S]*v_members\.id::text[\s\S]*'from_side', 'source'/);
  assert.match(sql, /'kind', 'relationship_field'[\s\S]*'relationship_field_id'/);
});

test('Department member report setup preserves unrelated reports and is safely repeatable', () => {
  assert.match(sql, /COALESCE\(v_existing->'reports', '\[\]'::jsonb\) \|\| jsonb_build_array\(v_report\)/);
  assert.match(sql, /WHERE report->>'id' = v_report_id/);
  assert.match(sql, /WHERE report = v_report/);
  assert.match(sql, /Existing BNMS Department members report differs/);
});