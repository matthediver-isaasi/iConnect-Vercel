#!/usr/bin/env node
// Only this reviewed additive migration. Offline by default; DEST-only on apply.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { destinationTarget } from './apply-custom-object-relationship-deleted-members-migration.mjs';
import { connectDestination, PROJECT } from './lib/member-index-destination.mjs';

export const MIGRATION = '20260901_campaign_event_survey_context.sql';
const columns = [
  ['email_campaign', 'event_survey_context', 'jsonb'],
  ['event_email', 'event_survey_assignment_id', 'uuid'],
];

export function validateMigration(sql) {
  const normalized = sql.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim();
  const expected = columns.map(([table, column, type]) =>
    `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${type};`).join(' ');
  if (normalized !== expected) throw new Error('Migration is not the exact approved two-column additive DDL.');
}

async function rowSnapshot(client, table, column) {
  const { rows } = await client.query(`
    SELECT count(*)::int AS count,
      md5(coalesce(string_agg(
        md5((to_jsonb(t) - '${column}')::text) || ':' || t.xmin::text,
        '' ORDER BY t.id), '')) AS digest
    FROM public.${table} t
  `);
  return rows[0];
}

export async function applyMigration(client, sql) {
  validateMigration(sql);
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL search_path = public");
    await client.query("SET LOCAL lock_timeout = '3s'");
    await client.query("SET LOCAL statement_timeout = '15s'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '30s'");
    // ADD COLUMN needs these locks anyway. Acquire both first so row/xmin
    // comparisons cannot be confused by unrelated concurrent application writes.
    await client.query('LOCK TABLE public.email_campaign, public.event_email IN ACCESS EXCLUSIVE MODE');
    const before = [];
    for (const [table, column] of columns) before.push(await rowSnapshot(client, table, column));
    await client.query(sql);
    const verification = [];
    for (const [index, [table, column, type]] of columns.entries()) {
      const result = await client.query(`
        SELECT format_type(a.atttypid, a.atttypmod) AS type,
          a.attnotnull AS not_null, a.atthasdef AS has_default
        FROM pg_attribute a
        WHERE a.attrelid = $1::regclass AND a.attname = $2 AND NOT a.attisdropped
      `, [`public.${table}`, column]);
      const definition = result.rows[0];
      if (!definition || definition.type !== type || definition.not_null || definition.has_default) {
        throw new Error('Unexpected column definition; migration rolled back.');
      }
      const after = await rowSnapshot(client, table, column);
      if (after.count !== before[index].count || after.digest !== before[index].digest) {
        throw new Error('Preexisting rows or row versions changed; migration rolled back.');
      }
      verification.push({ table, column, type, nullable: true, hasDefault: false,
        preexistingRowsVerified: after.count, preexistingRowsUnchanged: true });
    }
    await client.query('COMMIT');
    return verification;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

export async function main(args = process.argv.slice(2)) {
  if (args.some(arg => arg !== '--apply' && !/^--review-sha256=[a-f0-9]{64}$/.test(arg))) {
    throw new Error('Only --apply and --review-sha256 are supported.');
  }
  const sql = await readFile(new URL(`../migrations/${MIGRATION}`, import.meta.url), 'utf8');
  validateMigration(sql);
  const sha256 = createHash('sha256').update(sql).digest('hex');
  if (!args.includes('--apply')) {
    console.log(JSON.stringify({ dryRun: true, migration: MIGRATION, sha256, destinationProject: PROJECT }));
    return;
  }
  if (!args.includes(`--review-sha256=${sha256}`)) throw new Error('Exact reviewed SQL hash required.');
  // Independent REST + SQL project pins, strict parameter validation. The
  // existing connector supplies the trusted Supabase CA with TLS verification.
  destinationTarget(process.env);
  const client = await connectDestination();
  try {
    const verification = await applyMigration(client, sql);
    console.log(JSON.stringify({ applied: true, migration: MIGRATION, sha256,
      destinationProject: PROJECT, verification }));
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(JSON.stringify({ applied: false, errorCode: error.code || 'VALIDATION_FAILED',
      message: 'Migration not confirmed. Check destination pins, verified TLS and the exact reviewed SQL.' }));
    process.exitCode = 1;
  });
}