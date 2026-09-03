import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const migrationUrl = new URL(
  '../../supabase/migrations/20260825_custom_object_foundation.sql',
  import.meta.url,
);
const sql = await readFile(migrationUrl, 'utf8');
const schemaAdminSql = await readFile(
  new URL(
    '../../supabase/migrations/20260825_custom_object_schema_admin_guards.sql',
    import.meta.url,
  ),
  'utf8',
);
const relationshipRuntimeSql = await readFile(
  new URL(
    '../../supabase/migrations/20260826_custom_object_relationship_runtime.sql',
    import.meta.url,
  ),
  'utf8',
);
const atomicCreateSql = await readFile(
  new URL(
    '../../supabase/migrations/20260925_custom_object_record_relationship_create.sql',
    import.meta.url,
  ),
  'utf8',
);

test('migration uses shared generic tables instead of tenant-specific tables', () => {
  for (const table of [
    'custom_object_definition',
    'custom_object_record',
    'custom_object_relationship_definition',
    'custom_object_relationship',
    'custom_object_role_permission',
    'custom_object_audit_event',
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS public\\.${table}`));
  }
  assert.doesNotMatch(sql, /tenant_[0-9a-f]+_/i);
});

test('preference fields retain core scopes and add separate object ownership uniqueness', () => {
  assert.match(sql, /'member'::text/);
  assert.match(sql, /'organization'::text/);
  assert.match(sql, /'organization_group'::text/);
  assert.match(sql, /'custom_object'::text/);
  assert.match(sql, /preference_field_core_tenant_name_unique[\s\S]*WHERE custom_object_id IS NULL/);
  assert.match(sql, /preference_field_object_tenant_name_unique[\s\S]*WHERE custom_object_id IS NOT NULL/);
  assert.match(sql, /DROP CONSTRAINT IF EXISTS preference_field_name_key/);
  assert.match(
    sql,
    /preference_field_field_type_check[\s\S]*'textarea'::text[\s\S]*'file'::text/,
  );
  assert.match(sql, /'long_text'::text/);
  assert.doesNotMatch(sql, /ALTER TABLE public\.(member_preference_value|organization_preference_value|organization_group_preference_value)/);
});

test('tenant-leading indexes, RLS, and explicit service-role-only access are present', () => {
  assert.match(sql, /idx_custom_object_record_tenant_object_active[\s\S]*\(tenant_id, custom_object_id, id\)/);
  assert.match(sql, /idx_custom_object_relationship_tenant_source[\s\S]*\(tenant_id, source_record_id, relationship_definition_id\)/);
  assert.match(sql, /ALTER TABLE public\.custom_object_record ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /REVOKE ALL ON TABLE public\.custom_object_record FROM anon, authenticated/);
  assert.match(sql, /CREATE POLICY custom_object_record_service_role/);
});

test('database guards cover immutable keys, same-tenant ownership, cardinality, and append-only audit', () => {
  assert.match(sql, /custom_object_definition_immutable_identity/);
  assert.match(sql, /custom_object_definition_active_not_draft/);
  assert.match(sql, /preference_field_custom_object_immutable_identity/);
  assert.match(sql, /preference_field_custom_object_active_primary_required/);
  assert.match(sql, /custom_object_record_same_tenant/);
  assert.match(sql, /custom_object_relationship_source_valid/);
  assert.match(sql, /custom_object_relationship_target_valid/);
  assert.match(sql, /cod\.status = 'active'/);
  assert.match(sql, /custom_object_relationship_source_cardinality/);
  assert.match(sql, /custom_object_relationship_target_cardinality/);
  assert.match(sql, /custom_object_audit_event_object_same_tenant/);
  assert.match(sql, /custom_object_audit_event_record_same_tenant/);
  assert.match(sql, /custom_object_audit_event_definition_same_tenant/);
  assert.match(sql, /custom_object_audit_event_relationship_same_tenant/);
  assert.match(sql, /custom_object_audit_event_append_only/);
  assert.match(sql, /core_preference_value_custom_object_field/);
  assert.match(sql, /member_preference_value_custom_object_guard/);
  assert.match(sql, /organization_preference_value_custom_object_guard/);
  assert.match(sql, /organization_group_preference_value_custom_object_guard/);
  assert.match(sql, /audit_custom_object_mutation/);
  assert.match(sql, /v_actor_reference LIKE 'tenant_user:%'/);
  assert.match(sql, /v_actor_reference LIKE 'member:%'/);
  assert.match(sql, /custom_object_record_audit_trigger/);
  assert.match(schemaAdminSql, /custom_object_definition_active_not_draft/);
  assert.match(schemaAdminSql, /custom_object_audit_actor_type_trigger/);
  assert.match(schemaAdminSql, /NEW\.actor_type := 'tenant_user'/);
  assert.match(schemaAdminSql, /NEW\.actor_type := 'member'/);
});

test('forward migration transactionally protects required final edges under the relationship lock', () => {
  assert.match(relationshipRuntimeSql, /guard_custom_object_required_relationship/);
  assert.match(relationshipRuntimeSql, /pg_advisory_xact_lock\(hashtext\(OLD\.relationship_definition_id::text\)\)/);
  assert.match(relationshipRuntimeSql, /remaining\.source_record_id = OLD\.source_record_id/);
  assert.match(relationshipRuntimeSql, /remaining\.archived_at IS NULL/);
  assert.match(relationshipRuntimeSql, /custom_object_relationship_required_source/);
  assert.match(relationshipRuntimeSql, /BEFORE UPDATE OF archived_at/);
  assert.match(relationshipRuntimeSql, /archive_custom_object_relationship\(/);
  assert.match(relationshipRuntimeSql, /SECURITY DEFINER/);
  assert.match(relationshipRuntimeSql, /FOR UPDATE/);
  assert.match(relationshipRuntimeSql, /REVOKE ALL ON FUNCTION public\.archive_custom_object_relationship[\s\S]*PUBLIC, anon, authenticated/);
  assert.match(relationshipRuntimeSql, /archive_custom_object_record_relationships/);
  assert.match(relationshipRuntimeSql, /AFTER UPDATE OF archived_at ON public\.custom_object_record/);
  assert.match(relationshipRuntimeSql, /archive_custom_object_definition_relationships/);
  assert.match(relationshipRuntimeSql, /AFTER UPDATE OF status ON public\.custom_object_definition/);
  assert.match(relationshipRuntimeSql, /definition\.source_custom_object_id = NEW\.id[\s\S]*definition\.target_custom_object_id = NEW\.id/);
  assert.match(relationshipRuntimeSql, /SET status = 'archived',[\s\S]*archived_at = retirement_at,[\s\S]*archived_by = NEW\.archived_by/);
  assert.match(relationshipRuntimeSql, /archive_custom_object_relationship_definition_edges/);
  assert.match(relationshipRuntimeSql, /relationship\.relationship_definition_id = NEW\.id/);
  assert.match(relationshipRuntimeSql, /REVOKE ALL ON FUNCTION public\.archive_custom_object_definition_relationships\(\)[\s\S]*PUBLIC, anon, authenticated/);
});

test('dated atomic-create migration validates routed metadata and rolls record and edges back together', () => {
  assert.match(atomicCreateSql, /create_custom_object_record_with_relationships/);
  assert.match(atomicCreateSql, /SECURITY DEFINER/);
  assert.match(atomicCreateSql, /pg_advisory_xact_lock\(hashtext\(p_custom_object_id::text\)\)/);
  assert.match(atomicCreateSql, /definition\.source_kind <> 'custom_object'/);
  assert.match(atomicCreateSql, /definition\.target_kind <> 'custom_object'/);
  assert.match(atomicCreateSql, /show_on_source.*edit_from_source/s);
  assert.match(atomicCreateSql, /show_on_target.*edit_from_target/s);
  assert.match(atomicCreateSql, /item->>'originating'/);
  assert.match(atomicCreateSql, /routed_side = 'source'[\s\S]*show_on_target[\s\S]*edit_from_target/);
  assert.match(atomicCreateSql, /routed_side = 'target'[\s\S]*show_on_source[\s\S]*edit_from_source/);
  assert.match(atomicCreateSql, /custom_object_endpoint_exists/);
  assert.match(atomicCreateSql, /custom_object_required_relationship_create/);
  assert.match(atomicCreateSql, /REVOKE ALL ON FUNCTION public\.create_custom_object_record_with_relationships/);
});