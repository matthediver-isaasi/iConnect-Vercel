#!/usr/bin/env node
/**
 * PostgreSQL-only regression checks for the one-off DD readiness recovery
 * claimant.  This deliberately has no destination mode: every assertion runs
 * in a disposable local PostgreSQL cluster and in a unique scratch schema.
 *
 * The migration is applied after replacing only its public qualifications and
 * function search_path.  Thus this test cannot read or mutate a live/public
 * Supabase table.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import pg from 'pg';

const MIGRATION_PATH = path.resolve(
  process.cwd(),
  'supabase/migrations/20261031_form_due_diligence_readiness_claim_qualified.sql',
);
const migrationSql = await readFile(MIGRATION_PATH, 'utf8');

function executable(name) {
  const result = spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

function quoteIdentifier(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

function safeError(error) {
  return String(error?.message || error || 'unknown error')
    .replace(/postgres(?:ql)?:\/\/[^/\s]+/gi, 'postgresql://[redacted]')
    .replace(/password[=:][^\s,]+/gi, 'password=[redacted]');
}

function scratchMigration(schema) {
  // The migration must not be run against public, even on the local server.
  return migrationSql
    .replaceAll(/\bpublic\./g, `${schema}.`)
    .replaceAll(
      /SET\s+search_path\s*=\s*public\s*,\s*pg_temp/gi,
      `SET search_path = ${schema}, pg_temp`,
    );
}

async function startLocalPostgres() {
  const initdb = executable('initdb');
  const pgCtl = executable('pg_ctl');
  if (!initdb || !pgCtl) return null;

  const root = await mkdtemp(path.join(tmpdir(), 'form-dd-readiness-pg-'));
  const data = path.join(root, 'data');
  const socket = path.join(root, 'socket');
  const log = path.join(root, 'postgres.log');
  const port = String(24000 + (process.pid % 10000));
  await mkdir(socket, { recursive: true });

  try {
    const init = spawnSync(
      initdb,
      ['-D', data, '-A', 'trust', '-U', 'postgres', '--no-instructions'],
      { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 },
    );
    if (init.status !== 0) throw new Error(`initdb failed: ${safeError(init.stderr)}`);
    const started = spawnSync(
      pgCtl,
      [
        '-D',
        data,
        '-l',
        log,
        '-o',
        `-F -k ${socket} -c listen_addresses= -p ${port}`,
        '-w',
        'start',
      ],
      { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 },
    );
    if (started.status !== 0) throw new Error(`pg_ctl start failed: ${safeError(started.stderr)}`);

    const client = new pg.Client({
      host: socket,
      port,
      user: 'postgres',
      database: 'postgres',
    });
    await client.connect();
    return {
      client,
      stop: async () => {
        await client.end();
        spawnSync(pgCtl, ['-D', data, '-m', 'immediate', '-w', 'stop'], {
          encoding: 'utf8',
        });
        await rm(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    spawnSync(pgCtl, ['-D', data, '-m', 'immediate', '-w', 'stop'], { encoding: 'utf8' });
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

const ids = {
  tenantA: '00000000-0000-4000-8000-000000000001',
  tenantB: '00000000-0000-4000-8000-000000000002',
  formA: '10000000-0000-4000-8000-000000000001',
  eligible: '20000000-0000-4000-8000-000000000001',
  failed: '20000000-0000-4000-8000-000000000002',
  ready: '20000000-0000-4000-8000-000000000003',
  fresh: '20000000-0000-4000-8000-000000000004',
  attention: '20000000-0000-4000-8000-000000000005',
  leased: '20000000-0000-4000-8000-000000000006',
  pending: '20000000-0000-4000-8000-000000000007',
  monthly: '20000000-0000-4000-8000-000000000008',
  notEligible: '20000000-0000-4000-8000-000000000009',
  tenantMismatch: '20000000-0000-4000-8000-000000000010',
  legacy: '20000000-0000-4000-8000-000000000011',
};

test('one-off DD readiness claimant is tenant-safe and lease-safe', { timeout: 45_000 }, async t => {
  assert.match(
    migrationSql,
    /CREATE OR REPLACE FUNCTION public\.claim_missing_one_off_form_due_diligence_ready\s*\(\s*p_limit\s+INTEGER/i,
  );
  const backend = await startLocalPostgres();
  if (!backend) {
    t.skip('initdb and pg_ctl are unavailable');
    return;
  }

  const schema = `form_dd_readiness_test_${process.pid}_${randomUUID().replaceAll('-', '')}`;
  const S = quoteIdentifier(schema);
  const db = backend.client;

  try {
    await db.query("SET statement_timeout = '5s'");
    await db.query(`CREATE SCHEMA ${S}`);
    for (const role of ['anon', 'authenticated', 'service_role']) {
      const roleExists = await db.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
      if (roleExists.rowCount === 0) await db.query(`CREATE ROLE ${quoteIdentifier(role)}`);
    }
    // Keep gen_random_uuid in the same scratch search_path as the rewritten
    // SECURITY DEFINER function (a default public-schema extension would be
    // intentionally invisible there).
    await db.query(`CREATE EXTENSION pgcrypto WITH SCHEMA ${S}`);

    // These are the smallest business-table shapes consumed by the claimant.
    await db.query(`
      CREATE TABLE ${S}.form_submission (
        id UUID PRIMARY KEY,
        tenant_id UUID NOT NULL,
        form_id UUID NOT NULL,
        payment_status TEXT,
        payment_provider TEXT,
        payment_meta JSONB NOT NULL DEFAULT '{}'::JSONB
      );
      CREATE TABLE ${S}.form_due_diligence_initialization (
        form_submission_id UUID PRIMARY KEY,
        tenant_id UUID NOT NULL,
        paid_eligible BOOLEAN NOT NULL DEFAULT FALSE,
        state TEXT NOT NULL DEFAULT 'queued',
        lease_token UUID,
        lease_expires_at TIMESTAMPTZ,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE ${S}.form_due_diligence_one_off_ready (
        form_submission_id UUID PRIMARY KEY,
        tenant_id UUID NOT NULL,
        ready_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE ${S}.form_due_diligence_one_off_ready_recovery (
        form_submission_id UUID PRIMARY KEY,
        tenant_id UUID NOT NULL,
        state TEXT NOT NULL DEFAULT 'processing'
          CHECK (state IN ('processing', 'failed', 'completed', 'requires_attention')),
        lease_token UUID NOT NULL DEFAULT gen_random_uuid(),
        lease_expires_at TIMESTAMPTZ,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_error TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await db.query(scratchMigration(schema));

    const q = (sql, values) => db.query(sql, values);
    const insertSubmission = async (id, tenantId, paymentStatus, provider = 'stripe', meta = {}) =>
      q(
        `INSERT INTO ${S}.form_submission
           (id, tenant_id, form_id, payment_status, payment_provider, payment_meta)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, tenantId, ids.formA, paymentStatus, provider, meta],
      );
    const insertLifecycle = async (id, tenantId, overrides = {}) =>
      q(
        `INSERT INTO ${S}.form_due_diligence_initialization
           (form_submission_id, tenant_id, paid_eligible, state, next_attempt_at,
            created_at, updated_at)
         VALUES ($1, $2, $3, $4, COALESCE($5, NOW()), NOW() - INTERVAL '1 hour',
                 COALESCE($6, NOW() - INTERVAL '11 minutes'))`,
        [
          id,
          tenantId,
          overrides.paidEligible ?? true,
          overrides.state ?? 'queued',
          overrides.nextAttemptAt ?? null,
          overrides.updatedAt ?? null,
        ],
      );

    const finalized = { finalized: 'true', finalized_at: '2020-01-01T00:00:00Z' };
    await insertSubmission(ids.eligible, ids.tenantA, 'paid', 'stripe', finalized);
    await insertLifecycle(ids.eligible, ids.tenantA);

    await insertSubmission(ids.failed, ids.tenantA, 'paid', 'stripe', finalized);
    await insertLifecycle(ids.failed, ids.tenantA);
    const oldLease = '30000000-0000-4000-8000-000000000001';
    await q(
      `INSERT INTO ${S}.form_due_diligence_one_off_ready_recovery
         (form_submission_id, tenant_id, state, lease_token, next_attempt_at)
       VALUES ($1, $2, 'failed', $3, NOW() - INTERVAL '1 second')`,
      [ids.failed, ids.tenantA, oldLease],
    );

    await insertSubmission(ids.ready, ids.tenantA, 'paid', 'stripe', finalized);
    await insertLifecycle(ids.ready, ids.tenantA);
    await q(
      `INSERT INTO ${S}.form_due_diligence_one_off_ready (form_submission_id, tenant_id)
       VALUES ($1, $2)`,
      [ids.ready, ids.tenantA],
    );

    await insertSubmission(ids.fresh, ids.tenantA, 'paid', 'stripe', {
      finalized: 'true',
      finalized_at: new Date().toISOString(),
    });
    await insertLifecycle(ids.fresh, ids.tenantA);

    await insertSubmission(ids.attention, ids.tenantA, 'paid', 'stripe', {
      ...finalized,
      completion: { status: 'attention' },
    });
    await insertLifecycle(ids.attention, ids.tenantA);
    await q(
      `INSERT INTO ${S}.form_due_diligence_one_off_ready_recovery
         (form_submission_id, tenant_id, state, lease_expires_at)
       VALUES ($1, $2, 'requires_attention', NULL)`,
      [ids.attention, ids.tenantA],
    );

    await insertSubmission(ids.leased, ids.tenantA, 'paid', 'stripe', finalized);
    await insertLifecycle(ids.leased, ids.tenantA);
    await q(
      `INSERT INTO ${S}.form_due_diligence_one_off_ready_recovery
         (form_submission_id, tenant_id, state, lease_expires_at)
       VALUES ($1, $2, 'processing', NOW() + INTERVAL '10 minutes')`,
      [ids.leased, ids.tenantA],
    );

    await insertSubmission(ids.pending, ids.tenantA, 'pending', 'stripe', finalized);
    await insertLifecycle(ids.pending, ids.tenantA);
    await insertSubmission(ids.monthly, ids.tenantA, 'paid', 'stripe_monthly_card', finalized);
    await insertLifecycle(ids.monthly, ids.tenantA);
    await insertSubmission(ids.notEligible, ids.tenantA, 'paid', 'stripe', finalized);
    await insertLifecycle(ids.notEligible, ids.tenantA, { paidEligible: false });

    // The lifecycle tenant does not match the submission tenant: neither side
    // may be used to manufacture a cross-tenant recovery claim.
    await insertSubmission(ids.tenantMismatch, ids.tenantA, 'paid', 'stripe', finalized);
    await insertLifecycle(ids.tenantMismatch, ids.tenantB);

    // A pre-existing paid submission without the prospective lifecycle marker
    // is historical and must not acquire a recovery row.
    await insertSubmission(ids.legacy, ids.tenantA, 'paid', 'stripe', finalized);

    const call = () =>
      q(`SELECT * FROM ${S}.claim_missing_one_off_form_due_diligence_ready($1)`, [100]);
    const first = (await call()).rows;
    assert.equal(first.length, 2, 'only queued eligible and due failed rows should claim');
    assert.deepEqual(
      new Set(first.map(row => row.form_submission_id)),
      new Set([ids.eligible, ids.failed]),
    );
    for (const row of first) {
      assert.equal(row.tenant_id, ids.tenantA);
      assert.match(row.form_submission_id, /^[0-9a-f-]{36}$/i);
      assert.match(row.lease_token, /^[0-9a-f-]{36}$/i);
      const state = await q(
        `SELECT state, lease_token FROM ${S}.form_due_diligence_one_off_ready_recovery
          WHERE form_submission_id = $1 AND tenant_id = $2`,
        [row.form_submission_id, row.tenant_id],
      );
      assert.equal(state.rows[0].state, 'processing');
      assert.equal(state.rows[0].lease_token, row.lease_token);
      if (row.form_submission_id === ids.failed) assert.notEqual(row.lease_token, oldLease);
    }

    assert.equal((await call()).rowCount, 0, 'live processing leases are not reclaimed');
    const excluded = await q(
      `SELECT form_submission_id, state FROM ${S}.form_due_diligence_one_off_ready_recovery
        WHERE form_submission_id = ANY($1::UUID[])`,
      [[ids.ready, ids.fresh, ids.attention, ids.leased, ids.pending, ids.monthly, ids.notEligible,
        ids.tenantMismatch, ids.legacy]],
    );
    assert.deepEqual(
      new Set(excluded.rows.map(row => `${row.form_submission_id}:${row.state}`)),
      new Set([
        `${ids.attention}:requires_attention`,
        `${ids.leased}:processing`,
      ]),
      'ready, fresh, attention, and noneligible rows must not be claimed',
    );
    assert.equal(
      (await q(
        `SELECT count(*)::int AS count FROM ${S}.form_due_diligence_initialization
          WHERE form_submission_id = $1`,
        [ids.legacy],
      )).rows[0].count,
      0,
      'legacy completion must not manufacture a lifecycle row',
    );
  } finally {
    await backend.stop();
  }
});