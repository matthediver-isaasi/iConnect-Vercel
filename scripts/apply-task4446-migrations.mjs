#!/usr/bin/env node
/**
 * Destination-only, guarded rollout for Task #4446.
 *
 * The 20261028 migration contains an intentional INSERT backfill for paid
 * Stripe completion receipts. This runner refuses to apply any of the three
 * migrations if that backfill would touch an existing submission. With
 * --apply, it locks the submission and existing address-retry tables, checks
 * the guard inside the same transaction, applies all three files atomically,
 * verifies that no completion-retry rows were created by the backfill, and
 * commits. Any error rolls the transaction back.
 *
 * The already-applied 20261029 follow-up is separately pinned by SHA-256 and
 * can only be selected with --preflight-20261029 or --apply-20261029; those
 * modes never re-run the base 20261027/28 files.
 *
 * Usage:
 *   node scripts/apply-task4446-migrations.mjs       # read-only preflight
 *   node scripts/apply-task4446-migrations.mjs --apply
 *   node scripts/apply-task4446-migrations.mjs --preflight-20261029
 *   node scripts/apply-task4446-migrations.mjs --apply-20261029
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { isApprovedDestinationSupabaseTarget } from './lib/destinationSupabaseTarget.mjs';

const APPLY_BASE = process.argv.includes('--apply');
const APPLY_FOLLOW_UP = process.argv.includes('--apply-20261029');
const PREFLIGHT_FOLLOW_UP = process.argv.includes('--preflight-20261029');
const DESTINATION_CA_URL =
  'https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt';
const MIGRATIONS = [
  'supabase/migrations/20261027_form_payment_completion_owner_fencing.sql',
  'supabase/migrations/20261027_form_stripe_membership_address_retry.sql',
  'supabase/migrations/20261028_form_payment_completion_retry_and_pipeline_operation.sql',
];
const FOLLOW_UP_MIGRATION =
  'supabase/migrations/20261029_form_stripe_address_mapping_retry_completion.sql';
const FOLLOW_UP_SHA256 =
  '0d599dff6bd276bf484f5cffeaf3d01e2906992f30334473235a8a22e93b63eb';

if (Number(APPLY_BASE) + Number(APPLY_FOLLOW_UP) + Number(PREFLIGHT_FOLLOW_UP) > 1) {
  fail('choose only one of --apply, --apply-20261029, or --preflight-20261029');
}

function fail(message) {
  throw new Error(`[task-4446] ${message}`);
}

const connectionString = process.env.DEST_DATABASE_URL;
const destinationSupabaseUrl = process.env.DEST_SUPABASE_URL;
if (!connectionString || !destinationSupabaseUrl) {
  fail('DEST_DATABASE_URL and DEST_SUPABASE_URL are required; no database was changed.');
}
if (!isApprovedDestinationSupabaseTarget(connectionString, destinationSupabaseUrl)) {
  fail('connection is not the approved destination Supabase project; no database was changed.');
}

const caResponse = await fetch(DESTINATION_CA_URL);
if (!caResponse.ok) fail(`trusted destination CA could not be fetched (${caResponse.status}); no database was changed.`);
const ca = await caResponse.text();

const client = new pg.Client({
  connectionString,
  ssl: { rejectUnauthorized: true, ca },
});

const selectedMigrations = APPLY_FOLLOW_UP || PREFLIGHT_FOLLOW_UP
  ? [FOLLOW_UP_MIGRATION]
  : MIGRATIONS;
const migrationSql = await Promise.all(
  selectedMigrations.map(async migration => ({
    migration,
    sql: await readFile(path.resolve(process.cwd(), migration), 'utf8'),
  })),
);

function assertPinnedFollowUp(sql) {
  const digest = createHash('sha256').update(sql).digest('hex');
  if (digest !== FOLLOW_UP_SHA256) {
    fail(
      `20261029 SQL hash ${digest} does not match the pinned follow-up; `
      + 'no database was changed',
    );
  }
  // Dollar-quoted function bodies are executable only when their RPC is
  // called. No top-level row DML is allowed in this follow-up migration.
  const topLevelSql = sql.replace(/\$\$[\s\S]*?\$\$/g, '$$function-body$$');
  const directDml = topLevelSql.match(/\b(INSERT|UPDATE|DELETE|TRUNCATE|MERGE|COPY)\b/gi) || [];
  if (directDml.length > 0) {
    fail(
      `20261029 contains top-level data mutation (${directDml.join(', ')}); `
      + 'no database was changed',
    );
  }
}

if (APPLY_FOLLOW_UP || PREFLIGHT_FOLLOW_UP) {
  assertPinnedFollowUp(migrationSql[0].sql);
}

async function backfillCandidates() {
  const result = await client.query(`
    SELECT COUNT(*)::integer AS candidate_count
      FROM public.form_submission
     WHERE payment_provider = 'stripe'
       AND payment_status = 'paid'
       AND payment_meta->'completion'->>'version' = '1'
       AND payment_meta->'completion'->>'status' NOT IN ('done', 'attention')
  `);
  return result.rows[0].candidate_count;
}

async function rolloutState() {
  const result = await client.query(`
    SELECT
      (SELECT COUNT(*)::integer FROM public.form_submission
        WHERE payment_meta->'completion'->>'status' = 'processing') AS submission_processing,
      (SELECT COUNT(*)::integer FROM public.form_stripe_address_mapping_retry
        WHERE claimed_at IS NOT NULL
          AND claimed_at > NOW() - INTERVAL '5 minutes') AS active_address_retry_leases,
      (SELECT COUNT(*)::integer FROM public.form_stripe_address_mapping_processing_lease
        WHERE expires_at > NOW()) AS active_mapping_leases,
      (SELECT COUNT(*)::integer FROM public.form_paid_pipeline_operation
        WHERE status = 'processing') AS active_pipeline_operations,
      (SELECT COUNT(*)::integer FROM public.form_submission
        WHERE payment_meta->>'stripe_address_mappings_pending' = 'true') AS mapping_pending_submissions,
      (SELECT COUNT(*)::integer FROM public.form_submission) AS submission_rows,
      (SELECT COUNT(*)::integer FROM public.form_stripe_address_mapping_retry) AS address_retry_rows,
      (SELECT COUNT(*)::integer FROM public.form_stripe_address_mapping_ledger) AS mapping_ledger_rows,
      (SELECT COUNT(*)::integer FROM public.form_paid_pipeline_operation) AS pipeline_rows
  `);
  return result.rows[0];
}

async function assertFollowUpPrerequisites() {
  const result = await client.query(`
    SELECT
      to_regclass('public.form_stripe_address_mapping_ledger') IS NOT NULL AS ledger_table,
      to_regclass('public.form_stripe_address_mapping_processing_lease') IS NOT NULL AS mapping_lease_table,
      to_regclass('public.form_paid_pipeline_operation') IS NOT NULL AS pipeline_table,
      to_regprocedure('public.claim_form_stripe_address_mapping_retries(integer)') IS NOT NULL
        AS base_claim_signature,
      to_regprocedure('public.finish_form_stripe_address_mapping_retry(uuid,uuid,uuid,boolean,text)') IS NOT NULL
        AS base_fenced_finish_signature
  `);
  if (!Object.values(result.rows[0]).every(Boolean)) {
    fail(`20261029 prerequisites are not installed: ${JSON.stringify(result.rows[0])}`);
  }
}

async function completionRetryCount() {
  const result = await client.query(`
    SELECT COUNT(*)::integer AS row_count
      FROM public.form_payment_completion_retry
  `);
  return result.rows[0].row_count;
}

await client.connect();
try {
  if (PREFLIGHT_FOLLOW_UP) {
    await assertFollowUpPrerequisites();
    const state = await rolloutState();
    console.log(JSON.stringify({
      destination: 'approved',
      migration: FOLLOW_UP_MIGRATION,
      apply: false,
      pinnedSha256: FOLLOW_UP_SHA256,
      directDataMutationStatements: 0,
      ...state,
      safeToApplyWithoutExistingRowMutation: true,
      safeToApplyWithoutActiveProcessing: Object.entries(state)
        .filter(([key]) => (
          key.endsWith('_processing')
          || key.startsWith('active_')
          || key === 'mapping_pending_submissions'
        ))
        .every(([, value]) => value === 0),
    }));
  } else if (!APPLY_BASE && !APPLY_FOLLOW_UP) {
    const candidateCount = await backfillCandidates();
    console.log(JSON.stringify({
      destination: 'approved',
      apply: false,
      queueBackfillCandidates: candidateCount,
      safeToApplyWithoutSubmissionBackfill: candidateCount === 0,
    }));
  } else {
    await client.query('BEGIN');
    try {
      const followUp = APPLY_FOLLOW_UP;
      // Block form workers while replacing address/pipeline RPC definitions.
      // The lock also makes the before/after row-count guard meaningful.
      await client.query(followUp
        ? `LOCK TABLE public.form_submission,
                    public.form_stripe_address_mapping_retry,
                    public.form_stripe_address_mapping_ledger,
                    public.form_stripe_address_mapping_processing_lease,
                    public.form_paid_pipeline_operation
              IN SHARE ROW EXCLUSIVE MODE`
        : `LOCK TABLE public.form_submission, public.form_stripe_address_mapping_retry
              IN SHARE ROW EXCLUSIVE MODE`);

      const before = followUp ? await rolloutState() : null;
      if (followUp) {
        await assertFollowUpPrerequisites();
        const activeProcessing = [
          'submission_processing',
          'active_address_retry_leases',
          'active_mapping_leases',
          'active_pipeline_operations',
          'mapping_pending_submissions',
        ];
        const active = activeProcessing.filter(key => before[key] !== 0);
        if (active.length > 0) {
          fail(
            `20261029 rollout refused while existing processing state is present `
            + `(${active.map(key => `${key}=${before[key]}`).join(', ')}); `
            + 'wait for a quiet queue and retry; no database was changed',
          );
        }
      }

      const candidateCount = followUp ? null : await backfillCandidates();
      if (candidateCount !== null && candidateCount !== 0) {
        fail(
          `${candidateCount} existing paid Stripe completion row(s) match the 20261028 `
          + 'queue backfill; drain/review those rows and obtain explicit approval '
          + 'before applying these migrations',
        );
      }

      for (const { migration, sql } of migrationSql) {
        console.log(`Applying ${migration} atomically on approved DEST ...`);
        await client.query(sql);
      }

      const createdByBackfill = followUp ? null : await completionRetryCount();
      if (createdByBackfill !== null && createdByBackfill !== 0) {
        fail(
          `20261028 created ${createdByBackfill} completion-retry row(s) despite a zero-row `
          + 'preflight; transaction will be rolled back',
        );
      }

      const verification = await client.query(followUp ? `
        SELECT
          to_regprocedure('public.claim_form_stripe_address_mapping_retries(integer)') IS NOT NULL
            AS address_claim_signature,
          to_regprocedure('public.finish_form_stripe_address_mapping_retry(uuid,uuid,boolean,text)') IS NULL
            AS old_address_finish_removed,
          to_regprocedure('public.finish_form_stripe_address_mapping_retry(uuid,uuid,uuid,boolean,text)') IS NOT NULL
            AS fenced_address_finish_signature,
          to_regprocedure('public.begin_form_paid_pipeline_operation(uuid,uuid,uuid,text)') IS NOT NULL
            AS pipeline_signature,
          NOT has_function_privilege(
            'anon',
            'public.claim_form_stripe_address_mapping_retries(integer)',
            'EXECUTE'
          ) AS anon_address_denied,
          NOT has_function_privilege(
            'authenticated',
            'public.claim_form_stripe_address_mapping_retries(integer)',
            'EXECUTE'
          ) AS authenticated_address_denied,
          has_function_privilege(
            'service_role',
            'public.claim_form_stripe_address_mapping_retries(integer)',
            'EXECUTE'
          ) AS service_address_allowed,
          NOT has_function_privilege(
            'anon',
            'public.finish_form_stripe_address_mapping_retry(uuid,uuid,uuid,boolean,text)',
            'EXECUTE'
          ) AS anon_finish_denied,
          has_function_privilege(
            'service_role',
            'public.finish_form_stripe_address_mapping_retry(uuid,uuid,uuid,boolean,text)',
            'EXECUTE'
          ) AS service_finish_allowed,
          NOT has_function_privilege(
            'anon',
            'public.begin_form_paid_pipeline_operation(uuid,uuid,uuid,text)',
            'EXECUTE'
          ) AS anon_pipeline_denied,
          has_function_privilege(
            'service_role',
            'public.begin_form_paid_pipeline_operation(uuid,uuid,uuid,text)',
            'EXECUTE'
          ) AS service_pipeline_allowed,
          EXISTS (
            SELECT 1 FROM pg_proc
             WHERE oid = 'public.claim_form_stripe_address_mapping_retries(integer)'::regprocedure
               AND prosrc LIKE '%form_stripe_address_mapping_ledger%'
          ) AS claim_ledger_gate,
          EXISTS (
            SELECT 1 FROM pg_proc
             WHERE oid = 'public.begin_form_paid_pipeline_operation(uuid,uuid,uuid,text)'::regprocedure
               AND prosrc LIKE '%stripe_address_mappings_pending%'
          ) AS pipeline_mapping_gate
      ` : `
        SELECT
          to_regclass('public.form_payment_completion_retry') IS NOT NULL AS retry_table,
          to_regclass('public.form_paid_pipeline_operation') IS NOT NULL AS pipeline_table,
          EXISTS (
            SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public'
               AND table_name = 'form_stripe_address_mapping_retry'
               AND column_name = 'owner_token'
          ) AS address_owner_token,
          NOT has_function_privilege(
            'anon',
            'public.claim_form_stripe_address_mapping_retries(integer)',
            'EXECUTE'
          ) AS anon_address_denied,
          NOT has_function_privilege(
            'authenticated',
            'public.claim_form_stripe_address_mapping_retries(integer)',
            'EXECUTE'
          ) AS authenticated_address_denied,
          has_function_privilege(
            'service_role',
            'public.claim_form_stripe_address_mapping_retries(integer)',
            'EXECUTE'
          ) AS service_address_allowed,
          NOT has_function_privilege(
            'anon',
            'public.claim_form_payment_completion_retries(integer)',
            'EXECUTE'
          ) AS anon_completion_denied,
          has_function_privilege(
            'service_role',
            'public.claim_form_payment_completion_retries(integer)',
            'EXECUTE'
          ) AS service_completion_allowed
      `);
      const result = verification.rows[0];
      if (!Object.values(result).every(Boolean)) {
        fail(`post-apply verification failed: ${JSON.stringify(result)}`);
      }

      if (followUp) {
        const after = await rolloutState();
        for (const key of [
          'submission_rows',
          'address_retry_rows',
          'mapping_ledger_rows',
          'pipeline_rows',
          'mapping_pending_submissions',
        ]) {
          if (after[key] !== before[key]) {
            fail(
              `20261029 changed ${key} from ${before[key]} to ${after[key]}; `
              + 'transaction will be rolled back',
            );
          }
        }
      }

      await client.query('COMMIT');
      console.log(JSON.stringify({
        destination: 'approved',
        migration: followUp ? FOLLOW_UP_MIGRATION : '20261027/28 task chain',
        apply: true,
        committed: true,
        queueBackfillCandidates: candidateCount,
        completionRetryRowsCreatedByBackfill: createdByBackfill,
        existingSubmissionRowsPreserved: followUp ? true : undefined,
        directDataMutationStatements: followUp ? 0 : undefined,
      }));
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    }
  }
} finally {
  await client.end();
}