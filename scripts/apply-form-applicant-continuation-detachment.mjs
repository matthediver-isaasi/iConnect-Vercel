#!/usr/bin/env node
// Destination only. The default invocation is an offline checksum review.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { destinationTarget } from './apply-custom-object-relationship-deleted-members-migration.mjs';

export const MIGRATION = 'migrations/20260925_form_applicant_continuation_organization_detachment.sql';
const CA_URL = 'https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt';

export async function main(args = process.argv.slice(2), env = process.env) {
  if (args.some(arg => arg !== '--apply' && !/^--review-sha256=[a-f0-9]{64}$/.test(arg))
    || args.filter(arg => arg === '--apply').length > 1
    || args.filter(arg => arg.startsWith('--review-sha256=')).length > 1) {
    throw new Error('Supported arguments are --apply and --review-sha256=<sha256>.');
  }
  const sql = await readFile(new URL(`../${MIGRATION}`, import.meta.url), 'utf8');
  const sha256 = createHash('sha256').update(`${MIGRATION}\n${sql}`).digest('hex');
  if (!args.includes('--apply')) {
    console.log(JSON.stringify({
      dryRun: true,
      destinationProject: 'lvmzliemqnieeoruhkik',
      migration: MIGRATION,
      sha256,
      writesPerformed: false,
    }, null, 2));
    return;
  }
  if (!args.includes(`--review-sha256=${sha256}`)) {
    throw new Error('Reviewed migration SHA-256 is missing or does not match; no database was changed.');
  }

  const target = destinationTarget(env);
  const response = await fetch(CA_URL);
  if (!response.ok) throw new Error(`Destination CA download failed with HTTP ${response.status}; no database was changed.`);
  const ca = await response.text();
  if (!ca.includes('BEGIN CERTIFICATE')) throw new Error('Destination CA was not a PEM certificate; no database was changed.');
  const client = new pg.Client({
    connectionString: target.toString(),
    ssl: { rejectUnauthorized: true, ca, servername: target.hostname },
  });
  try {
    await client.connect();
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '10s'");
    await client.query("SET LOCAL statement_timeout = '120s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('task-4766-form-applicant-continuation-detachment'))");
    const prerequisite = await client.query(`
      SELECT to_regclass('public.form_applicant_continuation') IS NOT NULL AS has_grants,
        to_regclass('public.organization') IS NOT NULL AS has_organizations,
        to_regclass('public.form_draft_submission') IS NOT NULL AS has_drafts,
        to_regprocedure('public.bind_form_applicant_continuation(uuid,uuid,uuid,uuid,text)') IS NOT NULL AS has_bind,
        to_regprocedure('public.bind_form_applicant_draft(uuid,uuid,text)') IS NOT NULL AS has_draft_bind
    `);
    if (Object.values(prerequisite.rows[0] || {}).some(value => value !== true)) {
      throw new Error('Destination schema prerequisite check failed; transaction rolled back.');
    }
    await client.query(sql);
    const verification = await client.query(`
      SELECT
        NOT a.attnotnull AS organization_nullable,
        con.confdeltype = 'n' AS organization_delete_set_null,
        con.conkey = ARRAY[a.attnum]::smallint[] AS organization_fk_column_exact,
        to_regclass('public.form_applicant_continuation_organization_id_idx') IS NOT NULL AS organization_fk_index,
        EXISTS (
          SELECT 1 FROM pg_trigger trigger_row
          WHERE trigger_row.tgrelid = c.oid
            AND trigger_row.tgname = 'form_applicant_continuation_detachment_guard'
            AND NOT trigger_row.tgisinternal
        ) AS detachment_trigger,
        EXISTS (
          SELECT 1 FROM pg_constraint check_row
          WHERE check_row.conrelid = c.oid
            AND check_row.conname = 'form_applicant_continuation_detached_revoked_check'
            AND check_row.contype = 'c'
        ) AS detached_revoked_check,
        strpos(pg_get_functiondef(
          'public.bind_form_applicant_continuation(uuid,uuid,uuid,uuid,text)'::regprocedure
        ), 'g.organization_id is not null') > 0 AS continuation_rejects_null,
        strpos(pg_get_functiondef(
          'public.bind_form_applicant_draft(uuid,uuid,text)'::regprocedure
        ), 'organization_id is not null') > 0 AS draft_rejects_null
      FROM pg_class c
      JOIN pg_attribute a ON a.attrelid = c.oid
        AND a.attname = 'organization_id' AND NOT a.attisdropped
      JOIN pg_constraint con ON con.conrelid = c.oid
        AND con.conname = 'form_applicant_continuation_organization_id_fkey'
        AND con.contype = 'f' AND con.confrelid = 'public.organization'::regclass
      WHERE c.oid = 'public.form_applicant_continuation'::regclass
    `);
    const schema = verification.rows[0];
    if (!schema || Object.values(schema).some(value => value !== true)) {
      throw new Error('Applicant continuation detachment postconditions failed; transaction rolled back.');
    }
    await client.query("NOTIFY pgrst, 'reload schema'");
    await client.query('COMMIT');
    console.log(JSON.stringify({
      applied: true,
      destinationProject: 'lvmzliemqnieeoruhkik',
      migration: MIGRATION,
      sha256,
      schema,
    }, null, 2));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error('Applicant continuation detachment migration failed; no success confirmed. Check destination pins, TLS, prerequisites, and reviewed hash.');
    process.exitCode = 1;
  });
}