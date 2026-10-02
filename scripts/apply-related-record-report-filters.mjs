#!/usr/bin/env node
// Task 4922: offline hash review by default; explicit DEST-only reads/apply.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { destinationTarget } from './apply-custom-object-relationship-deleted-members-migration.mjs';

export { destinationTarget };
export const MIGRATION = '20261011_custom_object_report_filters.sql';
const PROJECT = 'lvmzliemqnieeoruhkik';
const CA_URL = 'https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt';
const TENANT = 'ff2df806-b321-4254-b651-3af11fccf1db';
const DEPARTMENT = 'cd1ebfd3-3e16-4091-be5a-99992d926f2f';

// Keep the runner's transaction open through post-apply checks. The SQL file's
// own outer transaction envelope must not commit ahead of those checks.
export function migrationBody(sql) {
  const start = /^(?:\s|--[^\n]*(?:\n|$))*BEGIN\s*;/i;
  const end = /COMMIT\s*;\s*$/i;
  if (!start.test(sql) || !end.test(sql)) {
    throw new Error('Reviewed migration transaction envelope changed; review runner compatibility.');
  }
  return sql.replace(start, '').replace(end, '');
}

async function connectDestination(env) {
  const target = destinationTarget(env);
  const response = await fetch(CA_URL, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error('Verified destination provider CA unavailable.');
  const ca = await response.text();
  if (!ca.includes('BEGIN CERTIFICATE')) throw new Error('Invalid destination provider CA.');
  const client = new pg.Client({
    connectionString: target.toString(),
    connectionTimeoutMillis: 30000,
    ssl: { rejectUnauthorized: true, ca, servername: target.hostname },
  });
  await client.connect();
  return client;
}

// No record values, member names or email values leave this query.
export async function inspectDestination(client) {
  const object = await client.query(`
    SELECT id, object_key, status FROM public.custom_object_definition
    WHERE tenant_id=$1 AND id=$2 AND object_key='org_department' AND status='active'
  `, [TENANT, DEPARTMENT]);
  if (object.rowCount !== 1) throw new Error('Active destination Department object pin mismatch.');
  const definitions = await client.query(`
    SELECT id, relationship_key, source_kind, target_kind, cardinality,
      COALESCE(configuration->'relationship_fields', configuration->'relationshipFields', '[]'::jsonb) AS fields
    FROM public.custom_object_relationship_definition
    WHERE tenant_id=$1 AND source_custom_object_id=$2 AND status='active'
      AND relationship_key='members' AND source_kind='custom_object'
      AND target_kind='member' AND target_custom_object_id IS NULL
  `, [TENANT, DEPARTMENT]);
  if (definitions.rowCount !== 1 || definitions.rows[0].cardinality !== 'many_to_many') {
    throw new Error('Active destination Department–Member relationship pin mismatch.');
  }
  const definition = definitions.rows[0];
  const fields = definition.fields.filter(field =>
    (field.type || field.field_type) === 'boolean'
    && /survey.*respond/i.test(`${field.key || field.name || ''} ${field.label || ''}`));
  if (fields.length !== 1 || !(fields[0].key || fields[0].name)) {
    throw new Error('Destination responder relationship metadata is unavailable or ambiguous.');
  }
  const field = fields[0];
  const counts = await client.query(`
    WITH departments AS (
      SELECT id FROM public.custom_object_record
      WHERE tenant_id=$1 AND custom_object_id=$2 AND archived_at IS NULL
    ), edges AS (
      SELECT e.source_record_id,e.target_record_id,e.field_values->$4 AS responder
      FROM public.custom_object_relationship e
      JOIN departments d ON d.id=e.source_record_id
      JOIN public.member m ON m.id=e.target_record_id AND m.tenant_id=$1
        AND (m.email IS NULL OR m.email !~* '^deleted_.+@deleted[.]local$')
      WHERE e.tenant_id=$1 AND e.relationship_definition_id=$3 AND e.archived_at IS NULL
    ), per_department AS (
      SELECT d.id,count(e.target_record_id) AS members,
        count(*) FILTER(WHERE e.responder='true'::jsonb) AS responders
      FROM departments d LEFT JOIN edges e ON e.source_record_id=d.id GROUP BY d.id
    )
    SELECT count(*) AS active_departments,
      (SELECT count(*) FROM edges) AS active_member_edges,
      (SELECT count(DISTINCT target_record_id) FROM edges) AS distinct_linked_members,
      (SELECT count(*) FROM edges WHERE responder='true'::jsonb) AS true_designation_edges,
      (SELECT count(*) FROM edges WHERE responder='false'::jsonb) AS false_designation_edges,
      (SELECT count(*) FROM edges WHERE responder IS NULL OR responder='null'::jsonb) AS unset_designation_edges,
      (SELECT count(*) FROM edges WHERE responder IS NOT NULL
        AND responder NOT IN ('true'::jsonb,'false'::jsonb,'null'::jsonb)) AS unsupported_designation_edges,
      count(*) FILTER(WHERE members=0) AS departments_without_members,
      count(*) FILTER(WHERE responders>0) AS departments_with_designated_responder,
      count(*) FILTER(WHERE responders=0) AS departments_with_no_designated_responder,
      count(*) FILTER(WHERE members>0 AND responders=0) AS departments_with_members_but_no_designated_responder
    FROM per_department
  `, [TENANT, DEPARTMENT, definition.id, field.key || field.name]);
  return {
    object: object.rows[0],
    relationship: { id: definition.id, key: definition.relationship_key, cardinality: definition.cardinality },
    field: { id: field.id || field.field_id, key: field.key || field.name, label: field.label, type: 'boolean' },
    counts: counts.rows[0],
  };
}

export async function main(args = process.argv.slice(2), env = process.env) {
  if (args.some(arg => !['--apply', '--inspect'].includes(arg) && !/^--review-sha256=[a-f0-9]{64}$/.test(arg))
    || new Set(args).size !== args.length
    || args.filter(arg => arg.startsWith('--review-sha256=')).length > 1
    || (args.includes('--apply') && args.includes('--inspect'))
    || (args.includes('--inspect') && args.some(arg => arg.startsWith('--review-sha256=')))) {
    throw new Error('Use no arguments, --inspect, or --apply --review-sha256=<sha256>.');
  }
  if (args.includes('--inspect')) {
    const client = await connectDestination(env);
    try {
      await client.query('BEGIN READ ONLY');
      await client.query("SET LOCAL statement_timeout='30s'");
      const baseline = await inspectDestination(client);
      await client.query('ROLLBACK');
      console.log(JSON.stringify({ destination: PROJECT, verifiedTls: true, readOnly: true, baseline, writesPerformed: false }, null, 2));
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      await client.end();
    }
    return;
  }
  const sql = await readFile(new URL(`../supabase/migrations/${MIGRATION}`, import.meta.url), 'utf8');
  const sha256 = createHash('sha256').update(sql).digest('hex');
  if (!args.includes('--apply')) {
    console.log(JSON.stringify({
      dryRun: true, migration: MIGRATION, sha256, writesPerformed: false,
      nextStep: 'Review this exact SQL hash and await explicit post-test apply authorization.',
    }, null, 2));
    return;
  }
  if (!args.includes(`--review-sha256=${sha256}`)) {
    throw new Error('Exact reviewed migration SHA-256 is required; no database was changed.');
  }
  const body = migrationBody(sql);
  const client = await connectDestination(env);
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='120s'");
    const baseline = await inspectDestination(client);
    // Deliberately execute exactly one new generic migration, never historical
    // report seeds, export jobs, report saves, or Department/member mutations.
    await client.query(body);
    await verifyFunctions(client);
    await verifyDepartmentReport(client, baseline);
    await client.query("NOTIFY pgrst, 'reload schema'");
    await client.query('COMMIT');
    console.log(JSON.stringify({ applied: true, destination: PROJECT, migration: MIGRATION, sha256 }, null, 2));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

async function verifyFunctions(client) {
  const result = await client.query(`
    SELECT p.proname,
      p.proconfig = ARRAY['search_path=public']::text[]
      AND has_function_privilege('service_role', p.oid, 'EXECUTE')
      AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
      AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
      AND NOT EXISTS (
        SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
        WHERE a.grantee=0 AND a.privilege_type='EXECUTE'
      ) AS valid
    FROM pg_proc p WHERE p.oid IN (
      to_regprocedure('public.custom_object_report_filtered_summary_page(uuid,text,uuid,jsonb,boolean,integer,integer,text,boolean,jsonb)'),
      to_regprocedure('public.custom_object_report_filter_value(jsonb,jsonb,text,text)'),
      to_regprocedure('public.custom_object_report_filter_predicate(uuid,text,uuid,text,jsonb)')
    )
  `);
  if (result.rowCount !== 3 || result.rows.some(row => row.valid !== true)) {
    throw new Error('Filtered report RPC post-apply contract verification failed; transaction rolled back.');
  }
}

async function verifyDepartmentReport(client, baseline) {
  const filter = [{
    mode: 'none',
    path: [{
      relationship_definition_id: baseline.relationship.id, from_side: 'source',
      endpoint_kind: 'member', endpoint_custom_object_id: null,
    }],
    conditions: [{
      kind: 'relationship_field', relationship_definition_id: baseline.relationship.id,
      relationship_field_id: baseline.field.id, key: baseline.field.key, type: 'boolean',
      op: 'equals', value: true,
    }],
  }];
  for (const [filters, expected] of [
    [[], baseline.counts.active_departments],
    [filter, baseline.counts.departments_with_no_designated_responder],
  ]) {
    const result = await client.query(`
      SELECT public.custom_object_report_filtered_summary_page(
        $1::uuid,'custom_object',$2::uuid,'[]'::jsonb,false,0,1,NULL,true,$3::jsonb
      ) AS payload
    `, [TENANT, DEPARTMENT, JSON.stringify(filters)]);
    if (Number(result.rows[0]?.payload?.total) !== Number(expected)) {
      throw new Error('Department reference/report total mismatch; transaction rolled back.');
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    // Database/transport errors may contain credentials or business values.
    console.error('Related-record filter operation failed; no success confirmed. Check arguments, exact SQL hash, destination pins, provider CA, and RPC contracts.');
    process.exitCode = 1;
  });
}