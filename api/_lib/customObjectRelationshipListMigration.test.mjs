import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const sql = fs.readFileSync(
  new URL('../../supabase/migrations/20260928_custom_object_relationship_list_rpc.sql', import.meta.url),
  'utf8',
);

test('relationship list RPC keeps typed scalar and array predicates in PostgreSQL', () => {
  assert.match(sql, /replace\(COALESCE\(sf->>'value', ''\), '\*', '%'\)/);
  assert.match(sql, /\(r\.data->%L\) %s %L::jsonb/);
  assert.match(sql, /jsonb_array_elements_text\(CASE WHEN jsonb_typeof\(r\.data->%L\) = ''array''/);
  assert.match(sql, /scalar_kind IN \('any_of_array', 'none_of_array'\)/);
});

test('relationship list RPC validates relationship topology and linked endpoints', () => {
  assert.match(sql, /d\.show_on_source IS DISTINCT FROM false/);
  assert.match(sql, /d\.show_on_target IS DISTINCT FROM false/);
  assert.match(sql, /Relationship list endpoint is not an active tenant object/);
  assert.match(sql, /JOIN organization ep ON ep\.id = e\.%I AND ep\.tenant_id = \$1/);
  assert.match(sql, /JOIN member ep ON ep\.id = e\.%I AND ep\.tenant_id = \$1/);
});

test('relationship sort validation pins labels to the active primary display field', () => {
  assert.match(sql, /pf\.id = od\.primary_display_field_id/);
  assert.match(sql, /pf\.name = display_key/);
  assert.match(sql, /Invalid relationship display sort field/);
});

test('relationship count sort remains JSON numeric rather than text-lexical', () => {
  assert.match(sql, /to_jsonb\(\(SELECT count\(\*\)/);
  assert.doesNotMatch(sql, /\(%s\)::text AS sort_value/);
  assert.match(sql, /WITH matched AS \(\s*SELECT r\.id, \(%s\) AS sort_value/);
});

test('relationship selector preserves totals when an offset has no page rows', () => {
  assert.match(sql, /row_number\(\) over\(ORDER BY %s\) AS page_rank/);
  assert.match(sql, /SELECT NULL::uuid, count\(\*\)::bigint/);
  assert.match(sql, /HAVING NOT EXISTS \(SELECT 1 FROM page_rows\)/);
});

test('relationship list RPC is service-role only', () => {
  assert.match(sql, /SECURITY DEFINER SET search_path = public/);
  assert.match(sql, /REVOKE ALL ON FUNCTION[\s\S]*FROM PUBLIC, anon, authenticated/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION[\s\S]*TO service_role/);
  assert.match(sql, /NOTIFY pgrst, 'reload schema'/);
});

test('relationship projection returns only a bounded label sample with an exact window count', () => {
  assert.match(sql, /custom_object_record_relationship_projection/);
  assert.match(sql, /jsonb_array_length\(p_items\) > 100/);
  assert.match(sql, /cardinality\(p_record_ids\) > 1000/);
  assert.match(sql, /count\(\*\) OVER \(\s*PARTITION BY matched\.item_id, matched\.routed_id/);
  assert.match(sql, /row_number\(\) OVER \(/);
  assert.match(sql, /WHERE ranked\.label_rank <= p_label_limit/);
  assert.match(sql, /custom_object_record_relationship_projection\(uuid,uuid,jsonb,uuid\[\],integer\) TO service_role/);
});