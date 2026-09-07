import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const sql = await readFile(
  new URL('./20261009_restore_custom_object_report_occurrence_page.sql', import.meta.url),
  'utf8',
);

test('forward repair recreates the exact occurrence paging contract', () => {
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.custom_object_report_occurrence_page\(\s*p_tenant_id uuid,\s*p_custom_object_id uuid,\s*p_relationship_definition_id uuid,\s*p_from_side text,\s*p_endpoint_kind text,\s*p_endpoint_custom_object_id uuid,\s*p_after_edge_id uuid,\s*p_include_total boolean,\s*p_offset integer,\s*p_limit integer\s*\)/);
  assert.match(sql, /root\.archived_at IS NULL/);
  assert.match(sql, /LIMIT LEAST\(GREATEST\(p_limit, 1\), 500\) \+ 1/);
  assert.match(sql, /'total', CASE WHEN p_include_total THEN \(SELECT count\(\*\) FROM eligible\) ELSE NULL END/);
});

test('forward repair is service-only and refreshes PostgREST', () => {
  const signature = String.raw`public\.custom_object_report_occurrence_page\(uuid,uuid,uuid,text,text,uuid,uuid,boolean,integer,integer\)`;
  assert.match(sql, new RegExp(`REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC`));
  assert.match(sql, new RegExp(`REVOKE ALL ON FUNCTION ${signature} FROM anon, authenticated`));
  assert.match(sql, new RegExp(`GRANT EXECUTE ON FUNCTION ${signature} TO service_role`));
  assert.match(sql, /NOTIFY pgrst, 'reload schema'/);
});