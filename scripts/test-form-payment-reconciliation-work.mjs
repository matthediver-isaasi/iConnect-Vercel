#!/usr/bin/env node
/**
 * Isolated behavioural checks for 20261030_form_payment_reconciliation_work.
 *
 * The default mode starts a temporary local PostgreSQL cluster.  Destination
 * mode is explicit (`--destination`) and is guarded by the same pinned
 * Supabase-target check used by the migration runner.  In either mode the
 * migration is rewritten into one unique scratch schema; no public queue,
 * RPC, or business table is called.
 *
 * Usage:
 *   node scripts/test-form-payment-reconciliation-work.mjs
 *   DEST_DATABASE_URL=... DEST_SUPABASE_URL=... \
 *     node scripts/test-form-payment-reconciliation-work.mjs --destination
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import pg from 'pg';
import { isApprovedDestinationSupabaseTarget } from './lib/destinationSupabaseTarget.mjs';

const MIGRATION_PATH = path.resolve(
  process.cwd(),
  'supabase/migrations/20261030_form_payment_reconciliation_work.sql',
);
const DESTINATION_CA_URL =
  'https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt';
const DESTINATION_MODE = process.argv.includes('--destination');

const migrationSql = await readFile(MIGRATION_PATH, 'utf8');
const rpcName = 'claim_form_payment_reconciliation_work';

function executable(name) {
  const result = spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function safeError(error) {
  // Do not print a connection string or a password supplied through an
  // environment variable.  The destination runner reports only a class.
  const message = String(error?.message || error || 'unknown error');
  return message
    .replace(/postgres(?:ql)?:\/\/[^/\s]+/gi, 'postgresql://[redacted]')
    .replace(/password[=:][^\s,]+/gi, 'password=[redacted]');
}

function quoteIdentifier(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

function makeSchemaName() {
  return `form_recon_test_${process.pid}_${randomUUID().replaceAll('-', '')}`;
}

function migrationForScratchSchema(schema) {
  // Only qualified public identifiers and the function search_path are
  // rewritten. No SQL is run against the public schema.
  return migrationSql
    .replaceAll(/\bpublic\./g, `${schema}.`)
    .replaceAll('SET search_path = public, pg_temp', `SET search_path = ${schema}, pg_temp`);
}

async function makeDestinationClient() {
  const connectionString = process.env.DEST_DATABASE_URL;
  const destinationUrl = process.env.DEST_SUPABASE_URL;
  if (!connectionString || !destinationUrl) {
    throw new Error('--destination requires DEST_DATABASE_URL and DEST_SUPABASE_URL');
  }
  if (!isApprovedDestinationSupabaseTarget(connectionString, destinationUrl)) {
    throw new Error('destination is not the approved pinned Supabase project');
  }
  const caResponse = await fetch(DESTINATION_CA_URL);
  if (!caResponse.ok) throw new Error(`destination CA fetch failed (${caResponse.status})`);
  const ca = await caResponse.text();
  const client = new pg.Client({
    connectionString,
    ssl: { rejectUnauthorized: true, ca },
  });
  await client.connect();
  return { client, stop: async () => client.end() };
}

async function makeLocalClient() {
  const initdb = executable('initdb');
  const pgCtl = executable('pg_ctl');
  if (!initdb || !pgCtl) return null;

  const root = await mkdtemp(path.join(tmpdir(), 'form-recon-pg-'));
  const data = path.join(root, 'data');
  const socket = path.join(root, 'socket');
  const log = path.join(root, 'postgres.log');
  const port = String(24000 + (process.pid % 10000));
  await mkdir(socket, { recursive: true });
  const init = spawnSync(initdb, ['-D', data, '-A', 'trust', '-U', 'postgres', '--no-instructions'], {
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024,
  });
  if (init.status !== 0) {
    await rm(root, { recursive: true, force: true });
    throw new Error(`initdb failed: ${safeError(init.stderr)}`);
  }
  const started = spawnSync(pgCtl, [
    '-D', data, '-l', log, '-o', `-F -k ${socket} -c listen_addresses= -p ${port}`,
    '-w', 'start',
  ], { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
  if (started.status !== 0) {
    await rm(root, { recursive: true, force: true });
    throw new Error(`pg_ctl start failed: ${safeError(started.stderr)}`);
  }
  const client = new pg.Client({
    host: socket,
    port,
    user: 'postgres',
    database: 'postgres',
  });
  try {
    await client.connect();
  } catch (error) {
    spawnSync(pgCtl, ['-D', data, '-m', 'immediate', '-w', 'stop'], { encoding: 'utf8' });
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  return {
    client,
    config: { host: socket, port, user: 'postgres', database: 'postgres' },
    stop: async () => {
      await client.end();
      spawnSync(pgCtl, ['-D', data, '-m', 'immediate', '-w', 'stop'], { encoding: 'utf8' });
      await rm(root, { recursive: true, force: true });
    },
  };
}

let backend;
let schema;
let schemaCreated = false;
let setupError = null;

try {
  backend = DESTINATION_MODE ? await makeDestinationClient() : await makeLocalClient();
  if (backend) {
    schema = makeSchemaName();
    const qSchema = quoteIdentifier(schema);
    await backend.client.query(`CREATE SCHEMA ${qSchema}`);
    schemaCreated = true;
    for (const role of ['anon', 'authenticated', 'service_role']) {
      const roleExists = await backend.client.query(
        'SELECT 1 FROM pg_roles WHERE rolname = $1',
        [role],
      );
      if (roleExists.rowCount === 0) {
        await backend.client.query(`CREATE ROLE ${quoteIdentifier(role)}`);
      }
    }

    // pgcrypto is present on Supabase and normally on a local installation.
    // This wrapper keeps the fixture independent of extension search_path.
    await backend.client.query(`
      CREATE TABLE ${qSchema}.form_submission (
        id UUID PRIMARY KEY,
        tenant_id UUID NOT NULL,
        payment_provider TEXT,
        payment_status TEXT,
        payment_paid_at TIMESTAMPTZ,
        payment_meta JSONB NOT NULL DEFAULT '{}'::JSONB
      );
      CREATE TABLE ${qSchema}.form_payment_completion_retry (
        form_submission_id UUID PRIMARY KEY REFERENCES ${qSchema}.form_submission(id) ON DELETE CASCADE,
        tenant_id UUID NOT NULL,
        next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        last_error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE ${qSchema}.form_stripe_address_mapping_retry (
        form_submission_id UUID PRIMARY KEY REFERENCES ${qSchema}.form_submission(id) ON DELETE CASCADE,
        tenant_id UUID NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        claimed_at TIMESTAMPTZ,
        owner_token UUID,
        last_error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE ${qSchema}.form_stripe_address_mapping_ledger (
        form_submission_id UUID PRIMARY KEY REFERENCES ${qSchema}.form_submission(id) ON DELETE CASCADE,
        tenant_id UUID NOT NULL,
        member_id UUID,
        organization_id UUID,
        mappings JSONB NOT NULL DEFAULT '[]'::JSONB,
        stripe_billing_address JSONB NOT NULL DEFAULT '{}'::JSONB,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await backend.client.query(migrationForScratchSchema(schema));
  }
} catch (error) {
  setupError = error;
}

test('migration has the pinned one-row service RPC contract', () => {
  assert.match(
    migrationSql,
    /CREATE OR REPLACE FUNCTION public\.claim_form_payment_reconciliation_work\(\)/,
  );
  assert.match(migrationSql, /RETURNS TABLE\(work_kind TEXT, submission JSONB, lease_token UUID\)/);
  assert.match(migrationSql, /SET search_path = public, pg_temp/);
  assert.match(
    migrationSql,
    /REVOKE ALL ON FUNCTION public\.claim_form_payment_reconciliation_work\(\)\s+FROM PUBLIC, anon, authenticated/s,
  );
  assert.match(
    migrationSql,
    /GRANT EXECUTE ON FUNCTION public\.claim_form_payment_reconciliation_work\(\)\s+TO service_role/s,
  );
  assert.doesNotMatch(migrationSql, /DROP FUNCTION/i);
});

test('migration leaves older RPC signatures untouched', () => {
  assert.doesNotMatch(migrationSql, /CREATE OR REPLACE FUNCTION public\.claim_form_payment_completion_retries/i);
  assert.doesNotMatch(migrationSql, /CREATE OR REPLACE FUNCTION public\.claim_form_stripe_address_mapping_retries/i);
  assert.doesNotMatch(migrationSql, /CREATE OR REPLACE FUNCTION public\.finish_form_payment_completion_retry/i);
  assert.doesNotMatch(migrationSql, /CREATE OR REPLACE FUNCTION public\.finish_form_stripe_address_mapping_retry/i);
});

test('destination/local scratch fixture is available', t => {
  if (!backend) {
    t.skip(setupError
      ? `PostgreSQL fixture unavailable: ${safeError(setupError)}`
      : 'local PostgreSQL tools unavailable');
    return;
  }
  assert.ok(schemaCreated, 'unique scratch schema was not created');
});

async function runBehaviouralChecks() {
  const db = backend.client;
  await db.query("SET statement_timeout = '5s'");
  const q = sql => db.query(sql);
  const S = quoteIdentifier(schema);
  const sub = {
    tenantA: '00000000-0000-4000-8000-000000000001',
    tenantB: '00000000-0000-4000-8000-000000000002',
    c1: '10000000-0000-4000-8000-000000000001',
    c2: '10000000-0000-4000-8000-000000000002',
    c3: '10000000-0000-4000-8000-000000000003',
    a1: '10000000-0000-4000-8000-000000000011',
    a2: '10000000-0000-4000-8000-000000000012',
    map: '10000000-0000-4000-8000-000000000021',
    monthly: '10000000-0000-4000-8000-000000000022',
    attention: '10000000-0000-4000-8000-000000000031',
    done: '10000000-0000-4000-8000-000000000032',
    active: '10000000-0000-4000-8000-000000000033',
    stale: '10000000-0000-4000-8000-000000000034',
    legacy: '10000000-0000-4000-8000-000000000035',
    jsonNull: '10000000-0000-4000-8000-000000000036',
    foreign: '10000000-0000-4000-8000-000000000041',
  };

  const claimSql = `SELECT work_kind, submission, lease_token FROM ${S}.claim_form_payment_reconciliation_work()`;
  const clear = async () => {
    await q(`DELETE FROM ${S}.form_payment_completion_retry`);
    await q(`DELETE FROM ${S}.form_stripe_address_mapping_retry`);
    await q(`DELETE FROM ${S}.form_stripe_address_mapping_ledger`);
    await q(`DELETE FROM ${S}.form_submission`);
  };
  const addSubmission = async (id, tenant, provider, status, meta) => {
    await db.query(
      `INSERT INTO ${S}.form_submission
         (id, tenant_id, payment_provider, payment_status, payment_paid_at, payment_meta)
       VALUES ($1, $2, $3, $4, NOW(), $5::jsonb)`,
      [id, tenant, provider, status, JSON.stringify(meta)],
    );
  };
  const addCompletion = async (id, tenant, ageMinutes = 10) => {
    await db.query(
      `INSERT INTO ${S}.form_payment_completion_retry
         (form_submission_id, tenant_id, next_attempt_at, attempt_count)
       VALUES ($1, $2, NOW() - ($3 || ' minutes')::interval, 0)`,
      [id, tenant, String(ageMinutes)],
    );
  };
  const addAddress = async (id, tenant, ageMinutes = 10, claimedAt = null) => {
    await db.query(
      `INSERT INTO ${S}.form_stripe_address_mapping_retry
         (form_submission_id, tenant_id, next_attempt_at, claimed_at, attempt_count)
       VALUES ($1, $2, NOW() - ($3 || ' minutes')::interval, $4, 0)`,
      [id, tenant, String(ageMinutes), claimedAt],
    );
  };
  const oneClaim = async (client = db) => {
    const result = await client.query(claimSql);
    assert.ok(result.rows.length <= 1, 'claim returned more than one row');
    return result.rows[0] || null;
  };
  const counter = async (table, id) => {
    const result = await db.query(
      `SELECT attempt_count, next_attempt_at
         FROM ${S}.${table} WHERE form_submission_id = $1`,
      [id],
    );
    return result.rows[0];
  };

  // Oldest due work is selected across both classes, and one claim bumps only
  // its selected queue row.
  await clear();
  await addSubmission(sub.c1, sub.tenantA, 'stripe', 'paid', { completion: { version: 1, status: 'queued' } });
  await addSubmission(sub.a1, sub.tenantA, 'stripe', 'paid', { membership: true });
  await addCompletion(sub.c1, sub.tenantA, 9);
  await addAddress(sub.a1, sub.tenantA, 20);
  let row = await oneClaim();
  if (!row) {
    const debug = await db.query(
      `SELECT r.form_submission_id, r.next_attempt_at, s.payment_meta,
              s.payment_provider, s.payment_status
         FROM ${S}.form_stripe_address_mapping_retry r
         JOIN ${S}.form_submission s ON s.id = r.form_submission_id`,
    );
    assert.fail(`expected first address claim, queue=${JSON.stringify(debug.rows)}`);
  }
  if (row.work_kind !== 'address') {
    const debug = await db.query(
      `SELECT 'completion' AS kind, r.form_submission_id, r.next_attempt_at
         FROM ${S}.form_payment_completion_retry r
        UNION ALL
       SELECT 'address' AS kind, r.form_submission_id, r.next_attempt_at
         FROM ${S}.form_stripe_address_mapping_retry r
       ORDER BY next_attempt_at`,
    );
    const checks = await db.query(
      `SELECT r.claimed_at,
              jsonb_typeof(s.payment_meta->'stripe_billing_address') AS address_type,
              s.payment_meta ? 'membership' AS has_membership,
              s.payment_meta->'completion'->>'version' AS completion_version,
              s.payment_meta->'completion'->>'status' AS completion_status,
              r.next_attempt_at <= NOW() AS due,
              (r.claimed_at IS NULL OR r.claimed_at < NOW() - INTERVAL '5 minutes') AS active_ok,
              ((s.payment_provider = 'stripe' AND s.payment_status = 'paid')
               OR (s.payment_provider = 'stripe_monthly_card' AND s.payment_status = 'setup_complete')) AS provider_ok,
              (jsonb_typeof(s.payment_meta->'stripe_billing_address') IS DISTINCT FROM 'object') AS snapshot_missing,
              COALESCE(s.payment_meta->'completion'->>'status', '') <> 'attention' AS attention_ok,
              NOT (s.payment_meta->'completion'->>'version' = '1'
                   AND jsonb_typeof(s.payment_meta->'stripe_billing_address') = 'object'
                   AND COALESCE(s.payment_meta->'completion'->>'status', '') NOT IN ('done', 'attention')) AS owner_ok
         FROM ${S}.form_stripe_address_mapping_retry r
         JOIN ${S}.form_submission s ON s.id = r.form_submission_id
        WHERE r.form_submission_id = '${sub.a1}'`,
    );
    assert.fail(`wrong first work kind ${row.work_kind}, queues=${JSON.stringify(debug.rows)}, checks=${JSON.stringify(checks.rows)}`);
  }
  assert.equal(row.work_kind, 'address');
  assert.equal(row.lease_token?.length, 36);
  assert.equal((await counter('form_stripe_address_mapping_retry', sub.a1)).attempt_count, 1);
  assert.equal((await counter('form_payment_completion_retry', sub.c1)).attempt_count, 0);
  await q(`UPDATE ${S}.form_stripe_address_mapping_retry SET next_attempt_at = NOW() + INTERVAL '1 hour' WHERE form_submission_id = '${sub.a1}'`);
  row = await oneClaim();
  if (!row) {
    const debug = await db.query(
      `SELECT r.form_submission_id, r.next_attempt_at, s.payment_meta,
              s.payment_provider, s.payment_status
         FROM ${S}.form_payment_completion_retry r
         JOIN ${S}.form_submission s ON s.id = r.form_submission_id`,
    );
    assert.fail(`expected second completion claim, queue=${JSON.stringify(debug.rows)}`);
  }
  assert.equal(row.work_kind, 'completion');
  assert.equal(row.lease_token, null);
  assert.equal((await counter('form_payment_completion_retry', sub.c1)).attempt_count, 1);

  // A failed/claimed oldest row is bumped for two minutes; the next due row
  // becomes claimable immediately rather than being starved.
  await clear();
  await addSubmission(sub.c1, sub.tenantA, 'stripe', 'paid', { completion: { version: 1, status: 'queued' } });
  await addSubmission(sub.c2, sub.tenantA, 'stripe', 'paid', { completion: { version: 1, status: 'queued' } });
  await addCompletion(sub.c1, sub.tenantA, 30);
  await addCompletion(sub.c2, sub.tenantA, 20);
  row = await oneClaim();
  assert.equal(row.submission.id, sub.c1);
  const c1AfterFirst = await counter('form_payment_completion_retry', sub.c1);
  assert.equal(c1AfterFirst.attempt_count, 1);
  assert.ok(new Date(c1AfterFirst.next_attempt_at) > new Date());
  row = await oneClaim();
  assert.equal(row.submission.id, sub.c2);
  assert.equal((await counter('form_payment_completion_retry', sub.c2)).attempt_count, 1);

  // Missing payment-time address makes completion ineligible. Once the
  // address worker captures the snapshot, completion owns the follow-up.
  await clear();
  await addSubmission(sub.map, sub.tenantA, 'stripe', 'paid', {
    completion: { version: 1, status: 'queued' },
    stripe_address_mapping_config: { mappings: [{ target_entity: 'member' }] },
  });
  await addAddress(sub.map, sub.tenantA, 10);
  row = await oneClaim();
  if (!row) {
    const debug = await db.query(
      `SELECT r.next_attempt_at, r.claimed_at, s.payment_meta,
              jsonb_typeof(s.payment_meta->'stripe_billing_address') AS address_type
         FROM ${S}.form_stripe_address_mapping_retry r
         JOIN ${S}.form_submission s ON s.id = r.form_submission_id
        WHERE r.form_submission_id = '${sub.map}'`,
    );
    assert.fail(`expected mapping address claim, queue=${JSON.stringify(debug.rows)}`);
  }
  assert.equal(row.work_kind, 'address');
  assert.equal((await counter('form_payment_completion_retry', sub.map))?.attempt_count || 0, 0);
  await q(`
    UPDATE ${S}.form_submission
       SET payment_meta = jsonb_set(
         payment_meta, '{stripe_billing_address}',
         '{"line1":"captured","country":"GB"}'::jsonb, true)
     WHERE id = '${sub.map}'
  `);
  await q(`UPDATE ${S}.form_stripe_address_mapping_retry SET next_attempt_at = NOW() WHERE form_submission_id = '${sub.map}'`);
  row = await oneClaim();
  assert.equal(row.work_kind, 'completion');
  assert.equal(row.lease_token, null);

  // Existing owner lease is excluded; a stale owner lease is reclaimable.
  await clear();
  await addSubmission(sub.monthly, sub.tenantA, 'stripe_monthly_card', 'setup_complete', { membership: true });
  await addAddress(sub.monthly, sub.tenantA, 10, new Date());
  row = await oneClaim();
  assert.equal(row, null);
  await q(`UPDATE ${S}.form_stripe_address_mapping_retry SET claimed_at = NOW() - INTERVAL '6 minutes' WHERE form_submission_id = '${sub.monthly}'`);
  row = await oneClaim();
  assert.equal(row.work_kind, 'address');
  assert.equal(row.lease_token?.length, 36);

  // Terminal completion and attention states are not claimable; attention
  // also gates the alternate address worker.
  await clear();
  await addSubmission(sub.done, sub.tenantA, 'stripe', 'paid', { completion: { version: 1, status: 'done' } });
  await addSubmission(sub.active, sub.tenantA, 'stripe', 'paid', {
    completion: {
      version: 1,
      status: 'processing',
      owner_token: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      claimed_at: new Date().toISOString(),
    },
  });
  await addSubmission(sub.attention, sub.tenantA, 'stripe', 'paid', {
    completion: { version: 1, status: 'attention' },
    membership: true,
  });
  await addCompletion(sub.done, sub.tenantA, 10);
  await addCompletion(sub.active, sub.tenantA, 10);
  await addAddress(sub.attention, sub.tenantA, 10);
  assert.equal(await oneClaim(), null);
  assert.equal((await counter('form_payment_completion_retry', sub.done)).attempt_count, 0);
  assert.equal((await counter('form_payment_completion_retry', sub.active)).attempt_count, 0);
  assert.equal((await counter('form_stripe_address_mapping_retry', sub.attention)).attempt_count, 0);

  // A processing completion with a fresh finalizer lease is excluded, while
  // the same receipt after the two-minute lease TTL is reclaimable.
  await clear();
  await addSubmission(sub.active, sub.tenantA, 'stripe', 'paid', {
    completion: {
      version: 1,
      status: 'processing',
      owner_token: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      claimed_at: new Date().toISOString(),
    },
  });
  await addSubmission(sub.stale, sub.tenantA, 'stripe', 'paid', {
    completion: {
      version: 1,
      status: 'processing',
      owner_token: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      claimed_at: '2000-01-01T00:00:00Z',
    },
  });
  await addCompletion(sub.active, sub.tenantA, 10);
  await addCompletion(sub.stale, sub.tenantA, 9);
  row = await oneClaim();
  assert.equal(row.submission.id, sub.stale);
  assert.equal(row.lease_token, null);
  assert.equal((await counter('form_payment_completion_retry', sub.active)).attempt_count, 0);

  // A legacy (no v1 completion) mapping with an object snapshot remains an
  // address obligation, and JSON null is treated as a missing snapshot.
  await clear();
  await addSubmission(sub.legacy, sub.tenantA, 'stripe', 'paid', {
    stripe_address_mapping_config: { mappings: [{ target_entity: 'member' }] },
    stripe_billing_address: { line1: 'legacy snapshot', country: 'GB' },
  });
  await addSubmission(sub.jsonNull, sub.tenantA, 'stripe', 'paid', {
    membership: true,
    stripe_billing_address: null,
  });
  await addAddress(sub.legacy, sub.tenantA, 9);
  await addAddress(sub.jsonNull, sub.tenantA, 10);
  row = await oneClaim();
  assert.equal(row.work_kind, 'address');
  assert.equal(row.submission.id, sub.jsonNull);
  row = await oneClaim();
  assert.equal(row.work_kind, 'address');
  assert.equal(row.submission.id, sub.legacy);

  // A queue row with a foreign tenant cannot join the submission or be
  // returned/bumped.
  await clear();
  await addSubmission(sub.foreign, sub.tenantA, 'stripe', 'paid', {});
  await addCompletion(sub.foreign, sub.tenantB, 10);
  assert.equal(await oneClaim(), null);
  assert.equal((await counter('form_payment_completion_retry', sub.foreign)).attempt_count, 0);

  // Two clients holding independent transactions must not claim the same
  // queue row. Each invocation still returns at most one row and bumps one
  // counter.
  await clear();
  await addSubmission(sub.c1, sub.tenantA, 'stripe', 'paid', { completion: { version: 1, status: 'queued' } });
  await addSubmission(sub.c2, sub.tenantA, 'stripe', 'paid', { completion: { version: 1, status: 'queued' } });
  await addCompletion(sub.c1, sub.tenantA, 20);
  await addCompletion(sub.c2, sub.tenantA, 10);
  const second = new pg.Client(backend.config || {
    connectionString: process.env.DEST_DATABASE_URL,
    ssl: { rejectUnauthorized: true, ca: await (await fetch(DESTINATION_CA_URL)).text() },
  });
  await second.connect();
  try {
    await second.query("SET statement_timeout = '5s'");
    await db.query('BEGIN');
    const firstClaim = await db.query(claimSql);
    assert.equal(firstClaim.rows.length, 1);
    await sleep(150);
    const secondClaim = await second.query(claimSql);
    assert.equal(secondClaim.rows.length, 1);
    assert.notEqual(firstClaim.rows[0].submission.id, secondClaim.rows[0].submission.id);
    await db.query('COMMIT');
    assert.equal((await counter('form_payment_completion_retry', sub.c1)).attempt_count, 1);
    assert.equal((await counter('form_payment_completion_retry', sub.c2)).attempt_count, 1);
  } finally {
    await db.query('ROLLBACK').catch(() => {});
    await second.end();
  }
}

test('isolated PostgreSQL behavioural contract', async t => {
  if (!backend) {
    t.skip(setupError
      ? `PostgreSQL fixture unavailable: ${safeError(setupError)}`
      : 'local PostgreSQL tools unavailable');
    return;
  }
  await runBehaviouralChecks();
});

after(async () => {
  try {
    if (backend && schemaCreated) {
      await backend.client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
      schemaCreated = false;
    }
  } catch (error) {
    console.error(`scratch cleanup failed: ${safeError(error)}`);
    process.exitCode = 1;
  } finally {
    if (backend) await backend.stop().catch(() => {});
  }
});