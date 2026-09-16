import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const sql = await readFile(new URL('./20261026_event_card_click_tracking.sql', import.meta.url), 'utf8');

test('event click storage is tenant-scoped, separated by event type, and cascades on deletion', () => {
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.event_card_click/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.complex_event_card_click/);
  assert.match(sql, /REFERENCES public\.event\(id\) ON DELETE CASCADE/);
  assert.match(sql, /REFERENCES public\.complex_event\(id\) ON DELETE CASCADE/);
  assert.match(sql, /UNIQUE \(tenant_id, event_id, visitor_key_hash\)/g);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_event_card_click_tenant_event/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_complex_event_card_click_tenant_event/);
  assert.match(sql, /BYTEA NOT NULL CHECK \(octet_length\(visitor_key_hash\) = 32\)/);
});

test('database functions atomically deduplicate and aggregate only opaque hashes', () => {
  assert.match(sql, /ON CONFLICT \(tenant_id, event_id, visitor_key_hash\) DO NOTHING/g);
  assert.match(sql, /p_visitor_key_hash !~ '\^\[0-9a-fA-F\]\{64\}\$'/);
  assert.match(sql, /decode\(lower\(p_visitor_key_hash\), 'hex'\)/);
  assert.match(sql, /jsonb_typeof\(pricing_config->'ticket_classes'\)/);
  assert.match(sql, /member_group_id IS NULL/);
  assert.match(sql, /get_event_card_click_counts/);
  assert.match(sql, /count\(\*\)::BIGINT/);
});

test('click tables and functions are restricted to service_role', () => {
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/g);
  assert.match(sql, /FORCE ROW LEVEL SECURITY/g);
  assert.match(sql, /REVOKE ALL ON TABLE public\.event_card_click FROM PUBLIC, anon, authenticated/);
  assert.match(sql, /REVOKE ALL ON TABLE public\.complex_event_card_click FROM PUBLIC, anon, authenticated/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.record_event_card_click[\s\S]*FROM PUBLIC, anon, authenticated/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.get_event_card_click_counts[\s\S]*FROM PUBLIC, anon, authenticated/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.record_event_card_click[\s\S]*TO service_role/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.get_event_card_click_counts[\s\S]*TO service_role/);
  assert.match(sql, /SET search_path = public, pg_temp/g);
});