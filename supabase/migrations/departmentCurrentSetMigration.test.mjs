import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const sql = await readFile(new URL('./20261101_department_current_set.sql', import.meta.url), 'utf8');
const authSql = await readFile(new URL('./20261102_department_current_set_auth.sql', import.meta.url), 'utf8');
const directWorkforceSql = await readFile(
  new URL('./20261103_department_current_set_direct_workforce.sql', import.meta.url),
  'utf8',
);
const departmentOrganisationAuthSql = await readFile(
  new URL('./20261104_department_current_set_department_organisation_auth.sql', import.meta.url),
  'utf8',
);

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

test('direct-workforce follow-up accepts only v2 direct configuration', () => {
  assert.match(directWorkforceSql, /p_config->>'version' = '2'/i);
  assert.match(directWorkforceSql, /NOT p_config \? 'workforce_object_id'/i);
  assert.match(directWorkforceSql, /NOT p_config->'relationship_ids' \? 'workforce_row'/i);
  assert.match(directWorkforceSql, /workforce_row_object_id.*department_object_id/is);
  assert.match(directWorkforceSql, /a pinned relationship definition is unavailable/i);
  assert.match(directWorkforceSql, /new workforce row is missing an active required field/i);
  assert.match(directWorkforceSql, /exact canonical option/i);
  assert.match(directWorkforceSql, /workforce rows must have one required Department/i);
  assert.doesNotMatch(directWorkforceSql, /jsonb_build_object\('survey_name'/i);
  assert.doesNotMatch(directWorkforceSql, /jsonb_build_object\('row_name'/i);
});

test('direct Department URLs require the same strict organisation parent as the picker', () => {
  assert.match(departmentOrganisationAuthSql, /department_current_set_assert_authorized/i);
  assert.match(departmentOrganisationAuthSql, /relationship_key = 'organisation'/i);
  assert.match(departmentOrganisationAuthSql, /target_kind = 'organization'/i);
  assert.match(departmentOrganisationAuthSql, /target_custom_object_id IS NULL/i);
  assert.match(departmentOrganisationAuthSql, /cardinality = 'many_to_one'/i);
  assert.match(departmentOrganisationAuthSql, /v_parent_definition_count <> 1/i);
  assert.match(departmentOrganisationAuthSql, /v_parent_edge_count <> 1 OR v_matching_parent_count <> 1/i);
  assert.match(departmentOrganisationAuthSql, /member\.organization_id/i);
});