import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { destinationTarget } from './apply-custom-object-relationship-deleted-members-migration.mjs';

const apply = process.argv.includes('--apply');
if (process.argv.slice(2).some(arg => !['--apply', '--preflight'].includes(arg))) throw new Error('Unknown argument');
const target = destinationTarget(process.env);
const response = await fetch('https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt');
if (!response.ok) throw new Error('Verified TLS certificate unavailable');
const client = new pg.Client({ connectionString: target.toString(),
  ssl: { rejectUnauthorized: true, ca: await response.text(), servername: target.hostname } });
const tenant = 'ff2df806-b321-4254-b651-3af11fccf1db';
const object = 'cd1ebfd3-3e16-4091-be5a-99992d926f2f';
const relationship = '0fdede92-efa2-4d84-9b16-df1a88069486';
const signatures = [
  'public.custom_object_report_occurrence_page(uuid,uuid,uuid,text,text,uuid,uuid,boolean,integer,integer)',
  'public.custom_object_report_distinct_counts(uuid,text,uuid,uuid[],jsonb)',
];
const page = async (cursor = null) => (await client.query(`SELECT public.custom_object_report_occurrence_page(
  $1,$2,$3,'source','member',NULL,$4,true,0,50) AS result`, [tenant, object, relationship, cursor])).rows[0].result;
try {
  await client.connect();
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  await client.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s'");
  const before = await page();
  const permissions = async () => (await client.query(`SELECT oid::text, proacl::text, prosecdef, proconfig
    FROM pg_proc WHERE oid = ANY($1::regprocedure[]) ORDER BY oid`, [signatures])).rows;
  const beforePermissions = await permissions();
  const expected = (await client.query(`SELECT e.id, d.id AS department_id, m.id AS member_id
    FROM public.custom_object_relationship e
    JOIN public.custom_object_record d ON d.id=e.source_record_id AND d.tenant_id=e.tenant_id
    JOIN public.member m ON m.id=e.target_record_id AND m.tenant_id=e.tenant_id
    WHERE e.tenant_id=$1 AND d.custom_object_id=$2 AND e.relationship_definition_id=$3
      AND e.archived_at IS NULL AND d.archived_at IS NULL
      AND COALESCE(m.email,'') !~* '^deleted_.+@deleted[.]local$'
    ORDER BY e.id`, [tenant, object, relationship])).rows;
  const departments = (await client.query(`SELECT id FROM public.custom_object_record
    WHERE tenant_id=$1 AND custom_object_id=$2 AND archived_at IS NULL ORDER BY id`,
  [tenant, object])).rows.map(row => row.id);
  const sql = await readFile(new URL('../supabase/migrations/20261201_department_reports_exclude_deleted_members.sql', import.meta.url), 'utf8');
  await client.query(sql);
  await client.query(sql); // Idempotent replay must preserve definitions and grants.
  assert.deepEqual(await permissions(), beforePermissions);
  await client.query('SET LOCAL ROLE service_role');
  const actualIds = [];
  let cursor = null;
  for (;;) {
    const result = await page(cursor);
    assert.equal(Number(result.total), expected.length);
    actualIds.push(...result.edges.map(edge => edge.id));
    if (!result.has_more) break;
    assert.ok(result.last_edge_id && result.last_edge_id !== cursor);
    cursor = result.last_edge_id;
  }
  assert.deepEqual(actualIds, expected.map(row => row.id), 'Preview/export cursor rows match non-deleted members exactly');
  const path = JSON.stringify([{ relationship_definition_id: relationship, from_side: 'source', endpoint_kind: 'member', endpoint_custom_object_id: null }]);
  let verifiedDepartments = 0;
  for (let i = 0; i < departments.length; i += 500) {
    const ids = departments.slice(i, i + 500);
    const result = (await client.query(`SELECT public.custom_object_report_distinct_counts(
      $1,'custom_object',$2,$3::uuid[],$4::jsonb) AS result`, [tenant, object, ids, path])).rows[0].result;
    assert.equal(result.length, ids.length);
    for (const row of result) {
      const count = new Set(expected.filter(edge => edge.department_id === row.record_id).map(edge => edge.member_id)).size;
      assert.equal(Number(row.count), count, 'Department summary counts exclude deleted members and retain zero counts');
      verifiedDepartments++;
    }
  }
  await client.query('RESET ROLE');
  await client.query(apply ? 'COMMIT' : 'ROLLBACK');
  console.log(JSON.stringify({ applied: apply, database: 'production DEST', beforeRows: before.total,
    afterRows: expected.length, verifiedDepartments, serviceRoleVerified: true,
    cursorPagingVerified: true, idempotencyVerified: true, permissionsUnchanged: true }));
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  console.error('Department report migration failed; transaction rolled back:', error.code || error.message);
  process.exitCode = 1;
} finally { await client.end(); }
