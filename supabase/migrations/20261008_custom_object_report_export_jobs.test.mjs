import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const sql = await readFile(
  new URL('./20261008_custom_object_report_export_jobs.sql', import.meta.url),
  'utf8',
);

test('report export jobs persist resumable progress and ordered idempotent chunks', () => {
  assert.match(sql, /next_page integer NOT NULL DEFAULT 1/);
  assert.match(sql, /cursor_value text/);
  assert.match(sql, /chunk_size integer NOT NULL DEFAULT 500/);
  assert.match(sql, /PRIMARY KEY \(job_id, chunk_index\)/);
  assert.match(sql, /claim_token uuid/);
  assert.match(sql, /status IN \('queued','processing','complete','failed'\)/);
});

test('report export job and chunk tables are tenant indexed with RLS enabled', () => {
  assert.match(sql, /ON public\.custom_object_report_export_job \(tenant_id, created_at DESC\)/);
  assert.match(sql, /ON public\.custom_object_report_export_chunk \(tenant_id, job_id, chunk_index\)/);
  assert.match(sql, /ALTER TABLE public\.custom_object_report_export_job ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /ALTER TABLE public\.custom_object_report_export_chunk ENABLE ROW LEVEL SECURITY/);
});

test('eligible occurrence paging and chunk commit are database-side and service-only', () => {
  assert.match(sql, /FUNCTION public\.custom_object_report_occurrence_page\(\s*p_tenant_id uuid,\s*p_custom_object_id uuid,\s*p_relationship_definition_id uuid,\s*p_from_side text,\s*p_endpoint_kind text,\s*p_endpoint_custom_object_id uuid,\s*p_after_edge_id uuid,\s*p_include_total boolean,\s*p_offset integer,\s*p_limit integer\s*\)/);
  assert.match(sql, /root\.archived_at IS NULL/);
  assert.match(sql, /'total', CASE WHEN p_include_total THEN \(SELECT count\(\*\) FROM eligible\) ELSE NULL END/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.custom_object_report_occurrence_page\(uuid,uuid,uuid,text,text,uuid,uuid,boolean,integer,integer\) FROM PUBLIC/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.custom_object_report_occurrence_page\(uuid,uuid,uuid,text,text,uuid,uuid,boolean,integer,integer\) FROM anon, authenticated/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.custom_object_report_occurrence_page\(uuid,uuid,uuid,text,text,uuid,uuid,boolean,integer,integer\) TO service_role/);
  assert.match(sql, /FUNCTION public\.custom_object_report_export_commit/);
  assert.match(sql, /claim_token = p_claim_token[\s\S]*FOR UPDATE/);
  assert.match(sql, /v_job\.next_page <> p_chunk_index \+ 1/);
  assert.match(sql, /next_page = next_page \+ 1/);
  assert.match(sql, /cursor_value = p_cursor_value/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.custom_object_report_export_commit[\s\S]*FROM PUBLIC/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.custom_object_report_export_commit[\s\S]*TO service_role/);
  assert.match(sql, /NOTIFY pgrst, 'reload schema'/);
});