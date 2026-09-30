import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const sql = await readFile(
  new URL('./20261004_bnms_getting_started_department_multiselect.sql', import.meta.url),
  'utf8',
);

test('BNMS form migration is pinned to the exact tenant, form, and relationship field', () => {
  assert.match(sql, /ff2df806-b321-4254-b651-3af11fccf1db/i);
  assert.match(sql, /4086425b-077e-42fe-b624-558fd012071c/i);
  assert.match(sql, /field_1788075892819/i);
  assert.match(sql, /30ad9dde-4b4e-4991-a7a4-8ef2b6b5138e/i);
  assert.match(sql, /tenant_id = v_tenant/i);
  assert.match(sql, /relationship_dropdown/i);
});

test('BNMS form migration enables multi-select and preserves the existing Other config', () => {
  assert.match(sql, /'\{selection_mode\}', '"multiple"'::jsonb/i);
  assert.match(sql, /COALESCE\(field->'not_listed_choice', '\{\}'::jsonb\)/i);
  assert.match(sql, /'\{"enabled":true\}'::jsonb/i);
  assert.doesNotMatch(sql, /"label"\s*:/i);
});

test('BNMS form migration fails closed on missing or ambiguous saved configuration', () => {
  assert.match(sql, /INTO STRICT v_fields/i);
  assert.match(sql, /IF v_match_count <> 1 THEN/i);
  assert.match(sql, /Expected exactly one BNMS Organisation Department relationship field/i);
  assert.match(sql, /fields IS DISTINCT FROM v_updated_fields/i);
});

test('BNMS form migration canonicalizes historical scalar submissions and resumable drafts', () => {
  for (const [table, column] of [
    ['form_submission', 'submission_data'],
    ['form_draft_submission', 'draft_data'],
  ]) {
    assert.match(sql, new RegExp(`UPDATE public\\.${table}[\\s\\S]*SET ${column} = jsonb_set`, 'i'));
    assert.match(
      sql,
      new RegExp(`jsonb_build_array\\(${column}->v_field\\)[\\s\\S]*jsonb_typeof\\(${column}->v_field\\) IN \\('string', 'number'\\)`, 'i'),
    );
  }
  assert.match(sql, /form_submission[\s\S]*tenant_id = v_tenant[\s\S]*form_id = v_form/i);
  assert.match(sql, /form_draft_submission[\s\S]*tenant_id = v_tenant::text[\s\S]*form_id = v_form::text/i);
  assert.match(sql, /NULLIF\(btrim\(submission_data->>v_field\), ''\) IS NOT NULL/i);
  assert.match(sql, /NULLIF\(btrim\(draft_data->>v_field\), ''\) IS NOT NULL/i);
});