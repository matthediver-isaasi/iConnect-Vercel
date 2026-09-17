import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const sql = await readFile(new URL('./20261101_department_current_set.sql', import.meta.url), 'utf8');
const authSql = await readFile(new URL('./20261102_department_current_set_auth.sql', import.meta.url), 'utf8');

test('current-set migration is service-only, scoped, and fail-closed', () => {
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.department_current_set_config/i);
  assert.match(sql, /department_current_set_commit[\s\S]*submission_id uuid NOT NULL REFERENCES public\.form_submission/i);
  assert.match(sql, /department_current_set_lock\(p_tenant_id\)/i);
  assert.match(sql, /edge\.field_values->\(p_config->>'respondent_field_key'\) = 'true'::jsonb/i);
  assert.match(sql, /multiple current workforce parents/i);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.department_current_set_load[\s\S]*GRANT EXECUTE[\s\S]*TO service_role/i);
  assert.doesNotMatch(sql, /GRANT EXECUTE ON FUNCTION public\.department_current_set_load[^\n]*\n\s*TO authenticated/i);
  assert.match(authSql, /FROM public\.session WHERE sid = p_session_id FOR SHARE/i);
  assert.match(sql, /created_member_id = p_member_id/i);
  assert.match(authSql, /member_group_assignment/i);
  assert.match(authSql, /department_current_set_reconcile_authenticated/i);
});