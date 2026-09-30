import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import { createLocalPostgresHarness } from '../../scripts/test-support/local-postgres-harness.mjs';

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const MEMBER_ID = '10000000-0000-4000-8000-000000000001';
const FORM_ID = '20000000-0000-4000-8000-000000000001';

let directory;
let cluster;
let harness;
let client;
let running = false;
let toolsAvailable = true;

function executable(name) {
  const result = spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

test.before(async () => {
  const initdb = executable('initdb');
  const pgCtl = executable('pg_ctl');
  if (!initdb || !pgCtl) {
    toolsAvailable = false;
    return;
  }

  harness = await createLocalPostgresHarness('form-monthly-card-pg-');
  directory = harness.socket;
  cluster = harness.data;
  const { port } = harness;
  execFileSync(initdb, [
    '-D', cluster, '-A', 'trust', '-U', 'runner', '--no-locale', '--no-instructions',
  ], { stdio: 'pipe' });
  execFileSync(pgCtl, [
    '-D', cluster,
    '-l', join(directory, 'postgres.log'),
    '-o', `-k ${directory} -p ${port} -h ''`,
    '-w', 'start',
  ], { stdio: 'pipe' });
  running = true;

  client = new pg.Client({
    host: directory,
    port,
    user: 'runner',
    database: 'postgres',
  });
  await client.connect();
  await client.query(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE ROLE service_role;

    CREATE TABLE member (
      id UUID PRIMARY KEY,
      tenant_id UUID NOT NULL
    );
    CREATE TABLE form (
      id UUID PRIMARY KEY,
      tenant_id UUID NOT NULL
    );
    CREATE TABLE form_submission (
      id UUID PRIMARY KEY,
      form_id UUID NOT NULL,
      tenant_id UUID NOT NULL,
      payment_status TEXT,
      payment_provider TEXT,
      payment_meta JSONB NOT NULL DEFAULT '{}'::JSONB
    );
    CREATE TABLE membership_billing_agreements (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL,
      member_id UUID,
      organization_id UUID,
      agreement_type TEXT NOT NULL DEFAULT 'member',
      provider TEXT,
      status TEXT NOT NULL DEFAULT 'payment_setup_required',
      idempotency_key TEXT,
      stripe_checkout_session_id TEXT,
      stripe_subscription_id TEXT,
      redirect_url TEXT,
      environment TEXT NOT NULL DEFAULT 'sandbox',
      needs_attention BOOLEAN NOT NULL DEFAULT false,
      attention_reason TEXT,
      metadata JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX membership_billing_agreements_idem_uniq
      ON membership_billing_agreements (idempotency_key)
      WHERE idempotency_key IS NOT NULL;
    CREATE TABLE membership_payment_plans (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      billing_agreement_id UUID
    );
    CREATE TABLE member_membership_history (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      billing_agreement_id UUID,
      status TEXT,
      payment_status TEXT
    );

    INSERT INTO member VALUES ('${MEMBER_ID}', '${TENANT_ID}');
    INSERT INTO form VALUES ('${FORM_ID}', '${TENANT_ID}');
  `);

  // Install the exact checked-in function and grants, rather than maintaining
  // a test-only copy that could drift from the deployed migration.
  const migration = await readFile(
    new URL('../../supabase/migrations/20260819_member_membership_history_billing_agreement_unique.sql', import.meta.url),
    'utf8',
  );
  const functionStart = migration.indexOf(
    'CREATE OR REPLACE FUNCTION release_expired_form_monthly_card_checkout(',
  );
  const nextSection = migration.indexOf(
    '-- Durable idempotency accepted by the workflow engine',
    functionStart,
  );
  assert.ok(functionStart >= 0 && nextSection > functionStart, 'release RPC must remain in its repository migration');
  await client.query(migration.slice(functionStart, nextSection));
});

test.after(async () => {
  if (client) await client.end();
  if (running) {
    execFileSync('pg_ctl', ['-D', cluster, '-m', 'immediate', '-w', 'stop'], { stdio: 'pipe' });
  }
  if (harness) await harness.cleanup();
});

test('PostgreSQL distinguishes an absent JSONB lease key from JSON null', async (t) => {
  if (!toolsAvailable) return t.skip('local PostgreSQL tools unavailable');
  const { rows: [row] } = await client.query(`
    SELECT
      ('{"monthly_card_state":null}'::jsonb->'monthly_card_state') IS NULL AS json_null_is_absent,
      ('{}'::jsonb->'monthly_card_state') IS NULL AS missing_key_is_absent
  `);
  assert.equal(row.json_null_is_absent, false);
  assert.equal(row.missing_key_is_absent, true);
});

test('expired form Checkout RPC releases the returning-member reservation and original applicant key', async (t) => {
  if (!toolsAvailable) return t.skip('local PostgreSQL tools unavailable');
  const submissionId = randomUUID();
  const agreementId = randomUUID();
  const checkoutSessionId = `cs_expired_${randomUUID()}`;
  const applicantKey = `form-card-applicant:${randomUUID()}`;

  await client.query(`
    INSERT INTO form_submission (
      id, form_id, tenant_id, payment_status, payment_provider, payment_meta
    ) VALUES (
      $1, $2, $3, 'pending', 'stripe_monthly_card',
      jsonb_build_object(
        'monthly_card',
        jsonb_build_object(
          'agreement_id', $4::text,
          'checkout_session_id', $5::text,
          'checkout_url', 'https://checkout.stripe.test/session'
        )
      )
    )
  `, [submissionId, FORM_ID, TENANT_ID, agreementId, checkoutSessionId]);

  await client.query(`
    INSERT INTO membership_billing_agreements (
      id, tenant_id, member_id, agreement_type, provider, status,
      idempotency_key, environment, stripe_checkout_session_id,
      redirect_url, metadata
    ) VALUES (
      $1, $2, $3, 'member', 'stripe', 'payment_setup_required',
      $4, 'sandbox', $5, 'https://checkout.stripe.test/session',
      jsonb_build_object('form_submission_id', $6::text)
    )
  `, [agreementId, TENANT_ID, MEMBER_ID, applicantKey, checkoutSessionId, submissionId]);

  const released = await client.query(
    'SELECT release_expired_form_monthly_card_checkout($1::uuid, $2::text) AS result',
    [agreementId, checkoutSessionId],
  );
  assert.equal(released.rows[0].result.ok, true);
  assert.equal(released.rows[0].result.released, true);

  const agreement = await client.query(`
    SELECT status, member_id, idempotency_key, stripe_checkout_session_id, redirect_url
      FROM membership_billing_agreements
     WHERE id = $1
  `, [agreementId]);
  assert.equal(agreement.rows[0].status, 'expired');
  assert.equal(agreement.rows[0].member_id, null);
  assert.notEqual(agreement.rows[0].idempotency_key, applicantKey);
  assert.equal(agreement.rows[0].stripe_checkout_session_id, null);
  assert.equal(agreement.rows[0].redirect_url, null);

  const submission = await client.query(`
    SELECT
      payment_meta->'monthly_card'->>'checkout_session_id' AS checkout_session_id,
      payment_meta->'monthly_card'->>'checkout_url' AS checkout_url
      FROM form_submission
     WHERE id = $1
  `, [submissionId]);
  assert.equal(submission.rows[0].checkout_session_id, null);
  assert.equal(submission.rows[0].checkout_url, null);

  // Reusing the original applicant key proves that the expired agreement no
  // longer consumes the uniqueness reservation.
  await client.query(`
    INSERT INTO membership_billing_agreements (
      tenant_id, member_id, agreement_type, provider, status,
      idempotency_key, environment, metadata
    ) VALUES (
      $1, $2, 'member', 'stripe', 'payment_setup_required',
      $3, 'sandbox', '{}'::jsonb
    )
  `, [TENANT_ID, MEMBER_ID, applicantKey]);

  const retry = await client.query(
    'SELECT release_expired_form_monthly_card_checkout($1::uuid, $2::text) AS result',
    [agreementId, checkoutSessionId],
  );
  assert.equal(retry.rows[0].result.ok, true);
  assert.equal(retry.rows[0].result.idempotent, true);
});