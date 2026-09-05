/**
 * Read-only destination verification for Custom Object CRM relationship lists.
 *
 * Usage:
 *   node scripts/verify-custom-object-relationship-list-live.mjs
 */
import assert from 'node:assert/strict';
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';
import { createCustomObjectService } from '../api/_lib/customObjectService.js';

const connectionString = process.env.DEST_DATABASE_URL;
const supabaseUrl = process.env.DEST_SUPABASE_URL;
const supabaseKey = process.env.DEST_SUPABASE_KEY;

if (!connectionString || !supabaseUrl || !supabaseKey) {
  throw new Error('DEST_DATABASE_URL, DEST_SUPABASE_URL, and DEST_SUPABASE_KEY are required');
}

const sqlClient = new pg.Client({
  connectionString,
  ssl: connectionString.includes('localhost') ? false : { rejectUnauthorized: false },
});

async function installedFunctions() {
  const { rows } = await sqlClient.query(`
    SELECT p.proname,
           p.prosecdef,
           p.proconfig,
           has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_execute,
           has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_execute,
           has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_execute
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN (
        'custom_object_record_relationship_list',
        'custom_object_record_relationship_projection'
      )
    ORDER BY p.proname
  `);
  return rows;
}

async function liveRelationshipCandidate() {
  const { rows } = await sqlClient.query(`
    WITH candidates AS (
      SELECT d.tenant_id,
             d.id AS relationship_id,
             'source'::text AS routed_side,
             d.source_custom_object_id AS routed_object_id,
             d.target_custom_object_id AS endpoint_object_id,
             e.source_record_id AS routed_record_id,
             e.target_record_id AS endpoint_record_id
      FROM custom_object_relationship_definition d
      JOIN custom_object_relationship e
        ON e.relationship_definition_id = d.id
       AND e.tenant_id = d.tenant_id
       AND e.archived_at IS NULL
      WHERE d.status = 'active'
        AND d.source_kind = 'custom_object'
        AND d.target_kind = 'custom_object'
        AND d.show_on_source IS DISTINCT FROM false
      UNION ALL
      SELECT d.tenant_id,
             d.id,
             'target'::text,
             d.target_custom_object_id,
             d.source_custom_object_id,
             e.target_record_id,
             e.source_record_id
      FROM custom_object_relationship_definition d
      JOIN custom_object_relationship e
        ON e.relationship_definition_id = d.id
       AND e.tenant_id = d.tenant_id
       AND e.archived_at IS NULL
      WHERE d.status = 'active'
        AND d.source_kind = 'custom_object'
        AND d.target_kind = 'custom_object'
        AND d.show_on_target IS DISTINCT FROM false
    )
    SELECT c.*
    FROM candidates c
    JOIN custom_object_definition routed
      ON routed.id = c.routed_object_id
     AND routed.tenant_id = c.tenant_id
     AND routed.status = 'active'
    JOIN custom_object_definition endpoint
      ON endpoint.id = c.endpoint_object_id
     AND endpoint.tenant_id = c.tenant_id
     AND endpoint.status = 'active'
    JOIN preference_field display_field
      ON display_field.id = endpoint.primary_display_field_id
     AND display_field.tenant_id = c.tenant_id
     AND display_field.custom_object_id = endpoint.id
     AND display_field.entity_scope = 'custom_object'
     AND display_field.is_active = true
    JOIN custom_object_record routed_record
      ON routed_record.id = c.routed_record_id
     AND routed_record.tenant_id = c.tenant_id
     AND routed_record.custom_object_id = c.routed_object_id
     AND routed_record.archived_at IS NULL
    JOIN custom_object_record endpoint_record
      ON endpoint_record.id = c.endpoint_record_id
     AND endpoint_record.tenant_id = c.tenant_id
     AND endpoint_record.custom_object_id = c.endpoint_object_id
     AND endpoint_record.archived_at IS NULL
    LIMIT 1
  `);
  return rows[0] || null;
}

async function main() {
  await sqlClient.connect();
  let functions;
  let candidate;
  try {
    [functions, candidate] = await Promise.all([
      installedFunctions(),
      liveRelationshipCandidate(),
    ]);
  } finally {
    await sqlClient.end();
  }

  assert.equal(functions.length, 2, 'both destination relationship-list functions must exist');
  for (const fn of functions) {
    assert.equal(fn.prosecdef, true, `${fn.proname} must be SECURITY DEFINER`);
    assert.equal(fn.anon_execute, false, `${fn.proname} must deny anon`);
    assert.equal(fn.authenticated_execute, false, `${fn.proname} must deny authenticated`);
    assert.equal(fn.service_execute, true, `${fn.proname} must allow service_role`);
    assert.ok(fn.proconfig?.includes('search_path=public'), `${fn.proname} must fix search_path`);
  }
  assert.ok(candidate, 'an active linked Custom Object pair is required for live verification');

  const db = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } });
  const service = createCustomObjectService({
    db,
    context: {
      isAuthenticated: true,
      tenantId: candidate.tenant_id,
      memberId: '00000000-0000-4000-8000-000000000001',
      roleId: null,
    },
    isAdmin: true,
  });
  const relationshipKey =
    `relationship:${candidate.relationship_id}:${candidate.routed_side}`;
  const relationshipColumns = JSON.stringify([relationshipKey]);
  const criteria = {
    filters: JSON.stringify({
      [relationshipKey]: {
        op: 'any_of',
        value: [candidate.endpoint_record_id],
      },
    }),
    relationshipColumns,
  };

  const filtered = await service.listRecords(candidate.routed_object_id, {
    ...criteria,
    page: 1,
    pageSize: 100,
    sortField: 'created_at',
    sortDir: 'desc',
  });
  assert.ok(filtered.total > 0 && filtered.data.length > 0);
  const relationshipValue = filtered.data[0].relationships?.[relationshipKey];
  assert.ok(relationshipValue?.count > 0);
  assert.ok(relationshipValue.records.length > 0 && relationshipValue.records.length <= 3);

  const sorted = await service.listRecords(candidate.routed_object_id, {
    page: 1,
    pageSize: 5,
    relationshipSort: relationshipKey,
    relationshipSortMode: 'count',
    sortDir: 'desc',
    relationshipColumns,
  });
  assert.ok(sorted.total > 0 && sorted.data.length > 0);
  const beyond = await service.listRecords(candidate.routed_object_id, {
    page: Math.ceil(sorted.total / 5) + 2,
    pageSize: 5,
    relationshipSort: relationshipKey,
    relationshipSortMode: 'count',
    sortDir: 'desc',
    relationshipColumns,
  });
  assert.equal(beyond.data.length, 0);
  assert.equal(beyond.total, sorted.total);

  const exported = await service.exportRecords(candidate.routed_object_id, {
    ...criteria,
    page: 1,
    pageSize: 1000,
    sortField: 'created_at',
    sortDir: 'desc',
  });
  assert.equal(exported.total, filtered.total);
  assert.ok(exported.data.length > 0);

  const options = await service.relationshipFilterOptions(candidate.routed_object_id, {
    fieldId: relationshipKey,
    selected: JSON.stringify([candidate.endpoint_record_id]),
    page: 1,
    pageSize: 25,
  });
  assert.ok(options.data.some((option) =>
    String(option.id) === String(candidate.endpoint_record_id)));

  console.log(JSON.stringify({
    destinationFunctionsInstalled: functions.length,
    functionGrantsSafe: true,
    filteredTotal: filtered.total,
    projectedLabelCount: relationshipValue.records.length,
    sortedTotal: sorted.total,
    outOfRangeTotalPreserved: beyond.total === sorted.total,
    exportTotalMatchesList: exported.total === filtered.total,
    selectedOptionRehydrated: true,
  }));
}

main().catch((error) => {
  console.error('Custom Object CRM live verification failed:', error.message);
  process.exit(1);
});