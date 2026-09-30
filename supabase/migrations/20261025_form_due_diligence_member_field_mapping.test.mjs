import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const migrationPath = new URL('./20261025_form_due_diligence_member_field_mapping.sql', import.meta.url);

let sql;
test.before(async () => {
  sql = await readFile(migrationPath, 'utf8');
});

test('Task #4423 adds an explicit member target to action and outbox rows', () => {
  assert.match(sql, /ALTER TABLE public\.stage_field_mapping_action[\s\S]*ADD COLUMN IF NOT EXISTS target_entity TEXT NOT NULL DEFAULT 'organization'/);
  assert.match(sql, /ALTER TABLE public\.form_due_diligence_field_mapping_workflow_outbox[\s\S]*ADD COLUMN IF NOT EXISTS target_entity TEXT NOT NULL DEFAULT 'organization'/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS member_id UUID REFERENCES public\.member\(id\) ON DELETE CASCADE/);
  assert.match(sql, /ALTER COLUMN organization_id DROP NOT NULL/);
  assert.match(sql, /CHECK \(target_entity IN \('organization', 'member'\)\)/);
});

test('stage action occurrences are persisted independently of updated_at', () => {
  assert.match(sql, /form_submission_due_diligence[\s\S]*ADD COLUMN IF NOT EXISTS stage_action_occurrence_id UUID/);
  assert.match(sql, /SET stage_action_occurrence_id = gen_random_uuid\(\)/);
  assert.match(sql, /ALTER COLUMN stage_action_occurrence_id SET DEFAULT gen_random_uuid\(\)/);
  assert.match(sql, /ALTER COLUMN stage_action_occurrence_id SET NOT NULL/);
});

test('Task #4423 removes the legacy RPC overload and revokes the unsafe public signature', () => {
  assert.match(sql, /DROP FUNCTION IF EXISTS public\.apply_form_due_diligence_field_mapping_with_outbox\(\s*UUID, UUID, TEXT, TEXT, UUID, JSONB, UUID, TEXT\s*\)/);
  assert.match(sql, /p_target_entity TEXT DEFAULT 'organization'/);
  assert.match(sql, /p_member_id UUID DEFAULT NULL/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.apply_form_due_diligence_field_mapping_with_outbox\(\s*UUID, UUID, TEXT, TEXT, UUID, JSONB, UUID, TEXT, TEXT, UUID\s*\) FROM PUBLIC, anon, authenticated/);
});

test('member RPC branches require tenant-owned members and validate member fields', () => {
  assert.match(sql, /FROM public\.member[\s\S]*WHERE id = p_member_id[\s\S]*AND tenant_id = p_tenant_id[\s\S]*FOR UPDATE/);
  assert.match(sql, /IF p_member_id IS NULL THEN[\s\S]*RAISE EXCEPTION 'member target is required'/);
  assert.match(sql, /key_name NOT IN \(\s*'first_name', 'last_name', 'job_title', 'mobile', 'landline'\s*\)/);
  assert.match(sql, /RAISE EXCEPTION 'invalid member field-mapping mutation'/);
});

test('member core and custom writes persist target-specific before/after fanout payloads', () => {
  assert.match(sql, /target_entity, organization_id, member_id, payload[\s\S]*'member', NULL, p_member_id/);
  assert.match(sql, /FROM public\.member_preference_value[\s\S]*WHERE member_id = p_member_id AND field_id = p_preference_field_id/);
  assert.match(sql, /INSERT INTO public\.member_preference_value \(member_id, field_id, value\)/);
  assert.match(sql, /'previous_value', v_preference_value,[\s\S]*'new_value', p_preference_value/);
});

test('same occurrence keys are checked before mutation and retain replay metadata', () => {
  assert.match(sql, /SELECT \* INTO v_existing_outbox[\s\S]*FOR UPDATE/);
  assert.match(sql, /v_existing_outbox\.event_type IS DISTINCT FROM p_event_type[\s\S]*v_existing_outbox\.member_id IS DISTINCT FROM p_member_id/);
  assert.match(sql, /v_existing_outbox\.payload->'mutation'[\s\S]*p_mutation/);
  assert.match(sql, /field-mapping event key already exists with a different mutation/);
  assert.match(sql, /'mutation', COALESCE\(p_mutation, '\{\}'::JSONB\)/);
  assert.match(sql, /'replayed', TRUE/);
});

test('RPC validates an existing occurrence before any mutation', () => {
  assert.match(sql, /pg_advisory_xact_lock\(hashtextextended\(/);
  assert.match(sql, /SELECT \* INTO v_existing_outbox[\s\S]*FOR UPDATE/);
  assert.match(sql, /different target/);
  assert.match(sql, /different mutation/);
  assert.match(sql, /different preference payload/);
  assert.doesNotMatch(sql, /ON CONFLICT \(form_submission_due_diligence_id, event_key\) DO NOTHING/);
});