#!/usr/bin/env node
// Destination only. Offline review is the default; --preflight is read-only.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { destinationTarget } from './apply-custom-object-relationship-deleted-members-migration.mjs';

export const MIGRATION = '202609200001_delete_communication_category_preserve_campaigns.sql';
const VERSION = '202609200001';
const CA_URL = 'https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt';

const requiredColumns = {
  communication_category: { id: 'uuid', tenant_id: 'uuid', name: 'text' },
  email_campaign: {
    id: 'uuid', tenant_id: 'uuid', name: 'text', status: 'text',
    communication_category_id: 'uuid', target_type: 'text',
    target_audiences: 'jsonb', scheduled_at: 'timestamp with time zone',
    updated_at: 'timestamp with time zone',
  },
  form: { id: 'uuid', tenant_id: 'uuid', communication_category_id: 'uuid' },
  audience_list: {
    id: 'uuid', tenant_id: 'uuid', communication_category_id: 'uuid',
    target_audiences: 'jsonb', updated_at: 'timestamp with time zone',
  },
  email_subscriber: { tenant_id: 'uuid', communication_category_id: 'uuid' },
  email_unsubscribe: { tenant_id: 'uuid', communication_category_id: 'uuid' },
  member_communication_preference: { tenant_id: 'uuid', category_id: 'uuid' },
  communication_category_role: { tenant_id: 'uuid', category_id: 'uuid' },
  member_transactional_message: {
    tenant_id: 'uuid', communication_category_id: 'uuid', updated_at: 'timestamp with time zone',
  },
};

const addedColumns = {
  email_campaign: {
    category_review_required: 'boolean',
    category_review_reason: 'jsonb',
    category_review_marked_at: 'timestamp with time zone',
    deleted_category_id: 'uuid',
    deleted_category_name: 'text',
  },
  audience_list: {
    category_review_required: 'boolean',
    category_review_reason: 'jsonb',
  },
  member_transactional_message: { deleted_category_name: 'text' },
};

async function columnState(client) {
  const tables = [...new Set([...Object.keys(requiredColumns), ...Object.keys(addedColumns)])];
  const { rows } = await client.query(`
    SELECT c.relname AS table_name, a.attname AS column_name,
      pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
      a.attnotnull AS not_null, pg_get_expr(d.adbin, d.adrelid) AS column_default
    FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum > 0 AND NOT a.attisdropped
    LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE n.nspname='public' AND c.relname = ANY($1::text[])
    ORDER BY c.relname,a.attnum
  `, [tables]);
  return rows;
}

function compareColumns(rows, specification, { textCompatible = false } = {}) {
  const actual = new Map(rows.map(row => [`${row.table_name}.${row.column_name}`, row]));
  const incompatible = [];
  for (const [table, columns] of Object.entries(specification)) {
    for (const [column, type] of Object.entries(columns)) {
      const row = actual.get(`${table}.${column}`);
      if (!row) incompatible.push({ column: `${table}.${column}`, expected: type, actual: 'missing' });
      else if (row.data_type !== type
        && !(textCompatible && type === 'text' && row.data_type.startsWith('character varying'))) {
        incompatible.push({ column: `${table}.${column}`, expected: type, actual: row.data_type });
      }
    }
  }
  return incompatible;
}

export async function inspectDestination(client) {
  const columns = await columnState(client);
  const targetIds = columns.find(row => row.table_name === 'email_campaign' && row.column_name === 'target_ids');
  const roles = await client.query(`
    SELECT rolname FROM pg_roles WHERE rolname=ANY($1::text[]) ORDER BY rolname
  `, [['anon', 'authenticated', 'service_role']]);
  const functions = await client.query(`
    SELECT p.proname, pg_get_function_result(p.oid) AS result_type,
      p.prosecdef AS security_definer, p.proconfig,
      has_function_privilege('service_role',p.oid,'EXECUTE') AS service_execute,
      has_function_privilege('anon',p.oid,'EXECUTE') AS anon_execute,
      has_function_privilege('authenticated',p.oid,'EXECUTE') AS authenticated_execute,
      NOT EXISTS (
        SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.grantee=0 AND a.privilege_type='EXECUTE'
      ) AS public_revoked
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.oid IN (
      to_regprocedure('public.delete_communication_category_preserving_campaigns(uuid,uuid)'),
      to_regprocedure('public.clear_email_campaign_category_review(uuid,uuid)')
    ) ORDER BY p.proname
  `);
  const historyTable = await client.query(`
    SELECT to_regclass('supabase_migrations.schema_migrations')::text AS table_name
  `);
  let history = [];
  if (historyTable.rows[0]?.table_name) {
    const result = await client.query(`
      SELECT version,name FROM supabase_migrations.schema_migrations WHERE version=$1
    `, [VERSION]);
    history = result.rows;
  }
  const prerequisiteIssues = compareColumns(columns, requiredColumns, { textCompatible: true });
  if (!targetIds) {
    prerequisiteIssues.push({ column: 'email_campaign.target_ids', expected: 'text[] or uuid[]', actual: 'missing' });
  } else if (!['text[]', 'uuid[]'].includes(targetIds.data_type)) {
    prerequisiteIssues.push({
      column: 'email_campaign.target_ids', expected: 'text[] or uuid[]', actual: targetIds.data_type,
    });
  }
  const roleNames = roles.rows.map(row => row.rolname);
  for (const role of ['anon', 'authenticated', 'service_role']) {
    if (!roleNames.includes(role)) prerequisiteIssues.push({ role, expected: 'exists', actual: 'missing' });
  }
  return {
    compatible: prerequisiteIssues.length === 0,
    prerequisiteIssues,
    prerequisiteColumns: columns
      .filter(row => requiredColumns[row.table_name]?.[row.column_name])
      .map(row => ({ column: `${row.table_name}.${row.column_name}`, type: row.data_type })),
    existingMigrationColumns: columns
      .filter(row => addedColumns[row.table_name]?.[row.column_name])
      .map(row => ({
        column: `${row.table_name}.${row.column_name}`,
        type: row.data_type,
        notNull: row.not_null,
        default: row.column_default,
      })),
    existingFunctions: functions.rows,
    grantRoles: roleNames,
    migrationHistoryTable: historyTable.rows[0]?.table_name || null,
    migrationHistoryRows: history,
    targetIdsType: targetIds?.data_type || null,
  };
}

async function assertPostconditions(client) {
  const columns = await columnState(client);
  const issues = compareColumns(columns, addedColumns);
  const reviewRequired = columns.filter(row =>
    ['email_campaign', 'audience_list'].includes(row.table_name)
    && row.column_name === 'category_review_required');
  if (reviewRequired.length !== 2
    || reviewRequired.some(row => !row.not_null || row.column_default !== 'false')) {
    issues.push({ column: '*.category_review_required', expected: 'boolean NOT NULL DEFAULT false' });
  }
  const report = await inspectDestination(client);
  const expectedResults = new Map([
    ['delete_communication_category_preserving_campaigns', 'jsonb'],
    ['clear_email_campaign_category_review', 'email_campaign'],
  ]);
  for (const [name, resultType] of expectedResults) {
    const fn = report.existingFunctions.find(row => row.proname === name);
    if (!fn || fn.result_type !== resultType || !fn.security_definer
      || !fn.proconfig?.some(value => /^search_path=public,\s*pg_temp$/.test(value))
      || !fn.service_execute || fn.anon_execute || fn.authenticated_execute || !fn.public_revoked) {
      issues.push({ function: name, expected: `SECURITY DEFINER, ${resultType}, private service_role execution` });
    }
  }
  if (issues.length) throw new Error(`Migration postconditions failed: ${JSON.stringify(issues)}`);
}

export async function runMigration(client, sql) {
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='10s'");
    await client.query("SET LOCAL statement_timeout='120s'");
    const before = await inspectDestination(client);
    if (!before.compatible) {
      throw new Error(`Destination schema is incompatible: ${JSON.stringify(before.prerequisiteIssues)}`);
    }
    await client.query(sql);
    await assertPostconditions(client);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

async function connectDestination(env) {
  const target = destinationTarget(env);
  const response = await fetch(CA_URL);
  if (!response.ok) throw new Error(`Destination CA download failed with HTTP ${response.status}.`);
  const ca = await response.text();
  if (!ca.includes('BEGIN CERTIFICATE')) throw new Error('Destination CA was not a PEM certificate.');
  const client = new pg.Client({
    connectionString: target.toString(),
    ssl: { rejectUnauthorized: true, ca, servername: target.hostname },
  });
  await client.connect();
  return client;
}

export async function main(args = process.argv.slice(2), env = process.env) {
  if (args.some(arg => !['--apply', '--preflight'].includes(arg)
      && !/^--review-sha256=[a-f0-9]{64}$/.test(arg))
    || args.filter(arg => arg === '--apply').length > 1
    || args.filter(arg => arg === '--preflight').length > 1
    || args.filter(arg => arg.startsWith('--review-sha256=')).length > 1
    || (args.includes('--apply') && args.includes('--preflight'))) {
    throw new Error('Supported modes: offline default, --preflight, or --apply --review-sha256=<sha256>.');
  }
  const sql = await readFile(new URL(`../supabase/migrations/${MIGRATION}`, import.meta.url), 'utf8');
  const sha256 = createHash('sha256').update(sql).digest('hex');
  if (!args.includes('--apply') && !args.includes('--preflight')) {
    console.log(JSON.stringify({ dryRun: true, migration: MIGRATION, sha256, writesPerformed: false }));
    return;
  }
  if (args.includes('--apply') && !args.includes(`--review-sha256=${sha256}`)) {
    throw new Error('Reviewed migration SHA-256 is missing or does not match; no database was changed.');
  }
  const client = await connectDestination(env);
  try {
    if (args.includes('--preflight')) {
      await client.query('BEGIN READ ONLY');
      const state = await client.query("SELECT current_setting('transaction_read_only') AS read_only");
      if (state.rows[0]?.read_only !== 'on') throw new Error('Read-only preflight could not be established.');
      const report = await inspectDestination(client);
      await client.query('ROLLBACK');
      console.log(JSON.stringify({
        preflight: true, readOnly: true, migration: MIGRATION, sha256,
        writesPerformed: false, ...report,
      }));
      return;
    }
    await runMigration(client, sql);
    console.log(JSON.stringify({ applied: true, migration: MIGRATION, sha256 }));
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error('Migration runner failed; no success confirmed. Review destination pins, TLS, schema, and approved hash.');
    process.exitCode = 1;
  });
}