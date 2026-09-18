/**
 * Explicit, database-enforced read-only production verification for Custom
 * Object CRM relationship lists.
 *
 * This is intentionally not a normal regression test or startup task.
 * Required opt-in:
 *   ICONNECT_PRODUCTION_READ_ONLY_VERIFY=custom-object-relationship-list
 *   ICONNECT_PRODUCTION_VERIFY_TENANT_ID=<production tenant UUID>
 *
 * All checks run through one PostgreSQL connection inside BEGIN READ ONLY and
 * are always rolled back. The target is pinned to project lvmzliemqnieeoruhkik.
 */
import assert from 'node:assert/strict';
import pg from 'pg';
import {
  assertProductionVerificationOptIn,
  createAuditedReadOnlyQuery,
  productionPgClientOptions,
  productionVerificationContract,
} from './_lib/productionReadOnlyVerification.mjs';

async function installedFunctions(query) {
  const { rows } = await query(`
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
  `, [], 'function-security-metadata');
  return rows;
}

async function liveRelationshipCandidate(query, tenantId) {
  const { rows } = await query(`
    WITH candidates AS (
      SELECT d.tenant_id,
             d.id AS relationship_id,
             'source'::text AS routed_side,
             d.source_custom_object_id AS routed_object_id,
             d.target_custom_object_id AS endpoint_object_id,
             display_field.name AS endpoint_display_key,
             e.source_record_id AS routed_record_id,
             e.target_record_id AS endpoint_record_id
      FROM custom_object_relationship_definition d
      JOIN custom_object_relationship e
        ON e.relationship_definition_id = d.id
       AND e.tenant_id = d.tenant_id
       AND e.archived_at IS NULL
      JOIN custom_object_definition endpoint
        ON endpoint.id = d.target_custom_object_id
       AND endpoint.tenant_id = d.tenant_id
       AND endpoint.status = 'active'
      JOIN preference_field display_field
        ON display_field.id = endpoint.primary_display_field_id
       AND display_field.tenant_id = d.tenant_id
       AND display_field.custom_object_id = endpoint.id
       AND display_field.entity_scope = 'custom_object'
       AND display_field.is_active = true
      WHERE d.tenant_id = $1
        AND d.status = 'active'
        AND d.source_kind = 'custom_object'
        AND d.target_kind = 'custom_object'
        AND d.show_on_source IS DISTINCT FROM false
      UNION ALL
      SELECT d.tenant_id, d.id, 'target'::text,
             d.target_custom_object_id, d.source_custom_object_id,
             display_field.name, e.target_record_id, e.source_record_id
      FROM custom_object_relationship_definition d
      JOIN custom_object_relationship e
        ON e.relationship_definition_id = d.id
       AND e.tenant_id = d.tenant_id
       AND e.archived_at IS NULL
      JOIN custom_object_definition endpoint
        ON endpoint.id = d.source_custom_object_id
       AND endpoint.tenant_id = d.tenant_id
       AND endpoint.status = 'active'
      JOIN preference_field display_field
        ON display_field.id = endpoint.primary_display_field_id
       AND display_field.tenant_id = d.tenant_id
       AND display_field.custom_object_id = endpoint.id
       AND display_field.entity_scope = 'custom_object'
       AND display_field.is_active = true
      WHERE d.tenant_id = $1
        AND d.status = 'active'
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
  `, [tenantId], 'tenant-scoped-candidate-read');
  return rows[0] || null;
}

async function verifyRelationshipFunctions(query, candidate) {
  const item = {
    list_field_id: `relationship:${candidate.relationship_id}:${candidate.routed_side}`,
    relationship_definition_id: candidate.relationship_id,
    side: candidate.routed_side,
    endpoint_kind: 'custom_object',
    endpoint_custom_object_id: candidate.endpoint_object_id,
    display_key: candidate.endpoint_display_key,
  };
  const filter = {
    relationship_definition_id: candidate.relationship_id,
    side: candidate.routed_side,
    op: 'any_of',
    values: [candidate.endpoint_record_id],
    endpoint_kind: 'custom_object',
    endpoint_custom_object_id: candidate.endpoint_object_id,
  };
  const scalarPlan = {
    filters: [],
    search: '',
    searchable_columns: [],
    sort_column: 'created_at',
    ascending: false,
  };

  const filtered = await query(`
    SELECT *
    FROM public.custom_object_record_relationship_list(
      $1::uuid, $2::uuid, false, $3::jsonb, $4::jsonb, NULL, 0, 100
    )
  `, [
    candidate.tenant_id,
    candidate.routed_object_id,
    JSON.stringify(scalarPlan),
    JSON.stringify([filter]),
  ], 'rpc:custom_object_record_relationship_list:filtered');
  assert.ok(filtered.rows.length > 0, 'relationship filter must return the linked routed record');
  assert.ok(filtered.rows.some((row) => String(row.record_id) === String(candidate.routed_record_id)));
  const filteredTotal = Number(filtered.rows[0].total_count);
  assert.ok(filteredTotal > 0);

  const projected = await query(`
    SELECT *
    FROM public.custom_object_record_relationship_projection(
      $1::uuid, $2::uuid, $3::jsonb, $4::uuid[], 3
    )
  `, [
    candidate.tenant_id,
    candidate.routed_object_id,
    JSON.stringify([item]),
    filtered.rows.map((row) => row.record_id).filter(Boolean),
  ], 'rpc:custom_object_record_relationship_projection');
  assert.ok(projected.rows.length > 0, 'bounded relationship projection must return labels');
  assert.ok(projected.rows.length <= filtered.rows.length * 3);
  assert.ok(projected.rows.every((row) => Number(row.total_count) > 0));

  const countSort = {
    ...filter,
    mode: 'count',
    ascending: false,
  };
  delete countSort.op;
  delete countSort.values;
  const sorted = await query(`
    SELECT *
    FROM public.custom_object_record_relationship_list(
      $1::uuid, $2::uuid, false, $3::jsonb, '[]'::jsonb, $4::jsonb, 0, 5
    )
  `, [
    candidate.tenant_id,
    candidate.routed_object_id,
    JSON.stringify({ ...scalarPlan, sort_column: null }),
    JSON.stringify(countSort),
  ], 'rpc:custom_object_record_relationship_list:sorted');
  assert.ok(sorted.rows.length > 0);
  const sortedTotal = Number(sorted.rows[0].total_count);
  assert.ok(sortedTotal > 0);

  const beyond = await query(`
    SELECT *
    FROM public.custom_object_record_relationship_list(
      $1::uuid, $2::uuid, false, $3::jsonb, '[]'::jsonb, $4::jsonb, $5, 5
    )
  `, [
    candidate.tenant_id,
    candidate.routed_object_id,
    JSON.stringify({ ...scalarPlan, sort_column: null }),
    JSON.stringify(countSort),
    (Math.ceil(sortedTotal / 5) + 1) * 5,
  ], 'rpc:custom_object_record_relationship_list:out-of-range');
  assert.equal(beyond.rows.length, 1, 'out-of-range RPC page must retain its count sentinel');
  assert.equal(beyond.rows[0].record_id, null);
  assert.equal(Number(beyond.rows[0].total_count), sortedTotal);

  return {
    filteredTotal,
    projectedLabelCount: projected.rows.length,
    sortedTotal,
    outOfRangeTotalPreserved: true,
  };
}

export async function main({
  env = process.env,
  Client = pg.Client,
} = {}) {
  // This gate intentionally runs before Client construction or connect().
  const { connectionString, tenantId } = assertProductionVerificationOptIn(env);
  const client = new Client(productionPgClientOptions(connectionString));
  const audit = [];
  const query = createAuditedReadOnlyQuery(client, audit);

  await client.connect();
  try {
    await query('BEGIN READ ONLY', [], 'transaction:begin-read-only');
    const transactionState = await query(`
      SELECT current_setting('transaction_read_only') AS transaction_read_only
    `, [], 'transaction:confirm-read-only');
    assert.equal(transactionState.rows[0]?.transaction_read_only, 'on');

    const tenant = await query(`
      SELECT id FROM public.tenant WHERE id = $1::uuid
    `, [tenantId], 'tenant-scope-validation');
    assert.equal(tenant.rows.length, 1, 'explicit production tenant does not exist');

    const functions = await installedFunctions(query);
    assert.equal(functions.length, 2, 'both destination relationship-list functions must exist');
    for (const fn of functions) {
      assert.equal(fn.prosecdef, true, `${fn.proname} must be SECURITY DEFINER`);
      assert.equal(fn.anon_execute, false, `${fn.proname} must deny anon`);
      assert.equal(fn.authenticated_execute, false, `${fn.proname} must deny authenticated`);
      assert.equal(fn.service_execute, true, `${fn.proname} must allow service_role`);
      assert.ok(fn.proconfig?.includes('search_path=public'), `${fn.proname} must fix search_path`);
    }

    const candidate = await liveRelationshipCandidate(query, tenantId);
    assert.ok(candidate, 'the explicit tenant needs an active linked Custom Object pair');
    assert.equal(String(candidate.tenant_id), tenantId);
    const checks = await verifyRelationshipFunctions(query, candidate);

    console.log(JSON.stringify({
      productionProject: productionVerificationContract.expectedProjectRef,
      tenantId,
      databaseReadOnlyTransaction: true,
      destinationFunctionsInstalled: functions.length,
      functionGrantsSafe: true,
      ...checks,
      auditedOperations: audit.length + 1,
    }));
  } finally {
    await query('ROLLBACK', [], 'transaction:rollback').catch(() => {});
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((error) => {
    console.error('Custom Object CRM production verification failed:', error.message);
    process.exitCode = 1;
  });
}