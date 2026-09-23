#!/usr/bin/env node
/**
 * Destination-only rollout for CRM Mailgun metadata in member_email.
 *
 * Usage:
 *   node scripts/apply-crm-member-email-provider.mjs
 *   node scripts/apply-crm-member-email-provider.mjs --apply
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { isApprovedDestinationSupabaseTarget } from './lib/destinationSupabaseTarget.mjs';

const apply = process.argv.includes('--apply');
const allowedArguments = new Set(['--apply']);
const unsupported = process.argv.slice(2).filter(value => !allowedArguments.has(value));
if (unsupported.length) throw new Error(`Unsupported argument: ${unsupported[0]}`);

const connectionString = process.env.DEST_DATABASE_URL;
const destinationSupabaseUrl = process.env.DEST_SUPABASE_URL;
if (!connectionString || !destinationSupabaseUrl) {
  throw new Error('DEST_DATABASE_URL and DEST_SUPABASE_URL are required; no database was changed.');
}
if (!isApprovedDestinationSupabaseTarget(connectionString, destinationSupabaseUrl)) {
  throw new Error('Connection is not the approved destination Supabase project; no database was changed.');
}

const migrationPath = path.resolve(
  process.cwd(),
  'supabase/migrations/20261122_member_email_provider_metadata.sql',
);
const migrationSql = await readFile(migrationPath, 'utf8');
const migrationHash = createHash('sha256').update(migrationSql).digest('hex');
const topLevelSql = migrationSql.replace(/--.*$/gm, '');
if (/\b(INSERT|UPDATE|DELETE|TRUNCATE|MERGE|COPY|DROP\s+TABLE)\b/i.test(topLevelSql)) {
  throw new Error('Migration contains an unexpected data mutation; no database was changed.');
}

const caResponse = await fetch(
  'https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt',
);
if (!caResponse.ok) {
  throw new Error(`Trusted destination CA could not be fetched (${caResponse.status}); no database was changed.`);
}
const ca = await caResponse.text();
const client = new pg.Client({
  connectionString,
  ssl: { rejectUnauthorized: true, ca },
});

async function schemaState() {
  const result = await client.query(`
    SELECT
      to_regclass('public.member_email') IS NOT NULL AS table_exists,
      (
        SELECT is_nullable = 'YES'
          FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'member_email'
           AND column_name = 'microsoft_message_id'
      ) AS microsoft_message_id_nullable,
      (
        SELECT data_type
          FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'member_email'
           AND column_name = 'email_provider'
      ) AS email_provider_type,
      (
        SELECT data_type
          FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'member_email'
           AND column_name = 'provider_message_id'
      ) AS provider_message_id_type,
      (
        SELECT indisunique AND indisvalid
          FROM pg_index
         WHERE indexrelid = to_regclass('public.member_email_provider_message_unique')
      ) AS provider_index_valid,
      (
        SELECT confrelid::regclass::text
          FROM pg_constraint constraint_row
          JOIN unnest(constraint_row.conkey) AS key_column(attnum) ON true
          JOIN pg_attribute attribute_row
            ON attribute_row.attrelid = constraint_row.conrelid
           AND attribute_row.attnum = key_column.attnum
         WHERE constraint_row.conrelid = 'public.member_email'::regclass
           AND constraint_row.contype = 'f'
           AND attribute_row.attname = 'synced_by_identity_id'
         LIMIT 1
      ) AS synced_by_identity_fk_target,
      (SELECT COUNT(*)::bigint FROM public.member_email) AS row_count
  `);
  return result.rows[0];
}

await client.connect();
try {
  const before = await schemaState();
  if (!before.table_exists) throw new Error('public.member_email does not exist on DEST.');
  console.log('DEST preflight:', {
    migrationHash,
    microsoftMessageIdNullable: before.microsoft_message_id_nullable,
    emailProviderType: before.email_provider_type,
    providerMessageIdType: before.provider_message_id_type,
    providerIndexValid: before.provider_index_valid,
    syncedByIdentityFkTarget: before.synced_by_identity_fk_target,
    rowCount: before.row_count,
  });
  if (!apply) {
    console.log('Read-only preflight complete; pass --apply to migrate DEST.');
    process.exitCode = 0;
  } else {
    await client.query('BEGIN');
    await client.query('LOCK TABLE public.member_email IN ACCESS EXCLUSIVE MODE');
    const lockedRowCount = await client.query('SELECT COUNT(*)::bigint AS count FROM public.member_email');
    if (lockedRowCount.rows[0].count !== before.row_count) {
      throw new Error('member_email row count changed during migration preflight.');
    }
    await client.query(migrationSql);
    const after = await schemaState();
    if (
      after.microsoft_message_id_nullable !== true
      || after.email_provider_type !== 'text'
      || after.provider_message_id_type !== 'text'
      || after.provider_index_valid !== true
      || after.row_count !== before.row_count
    ) {
      throw new Error('DEST schema verification failed; migration rolled back.');
    }
    await client.query('COMMIT');
    console.log('DEST migration applied and verified:', {
      microsoftMessageIdNullable: after.microsoft_message_id_nullable,
      emailProviderType: after.email_provider_type,
      providerMessageIdType: after.provider_message_id_type,
      providerIndexValid: after.provider_index_valid,
      syncedByIdentityFkTarget: after.synced_by_identity_fk_target,
      rowCount: after.row_count,
    });
  }
} catch (error) {
  try { await client.query('ROLLBACK'); } catch {}
  throw error;
} finally {
  await client.end();
}