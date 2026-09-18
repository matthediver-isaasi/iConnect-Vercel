#!/usr/bin/env node
/**
 * Task #4446 isolated PostgreSQL migration and concurrency checks.
 *
 * This runner never reads DATABASE_URL and never connects to a configured
 * database. It creates a temporary local PostgreSQL cluster with trust
 * authentication, binds only to a temporary Unix socket, and removes the
 * cluster on exit.
 *
 * Run from the repository root:
 *   node scripts/test-task4446-migrations.mjs
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

const migrationPaths = [
  'supabase/migrations/20261027_form_payment_completion_owner_fencing.sql',
  'supabase/migrations/20261027_form_stripe_membership_address_retry.sql',
  'supabase/migrations/20261028_form_payment_completion_retry_and_pipeline_operation.sql',
  'supabase/migrations/20261029_form_stripe_address_mapping_retry_completion.sql',
  'supabase/migrations/20261110_paid_pipeline_late_success.sql',
].map(file => path.resolve(process.cwd(), file));

const rpcSignatures = [
  'public.finish_form_payment_completion(uuid,uuid,uuid,text,text,text)',
  'public.capture_form_stripe_billing_address_once(uuid,uuid,jsonb)',
  'public.claim_form_stripe_address_mapping_retries(integer)',
  'public.finish_form_stripe_address_mapping_retry(uuid,uuid,uuid,boolean,text)',
  'public.queue_form_payment_completion(uuid,uuid)',
  'public.claim_form_payment_completion_retries(integer)',
  'public.finish_form_payment_completion_retry(uuid,uuid,text,text)',
  'public.begin_form_paid_pipeline_operation(uuid,uuid,uuid,text)',
  'public.observe_or_begin_form_paid_pipeline_operation(uuid,uuid,uuid,text)',
  'public.finish_form_paid_pipeline_operation(uuid,uuid,uuid,text,text)',
  'public.mark_stale_submission_email_attention(uuid,uuid)',
  'public.claim_missing_one_off_form_due_diligence_ready(integer)',
  'public.list_form_due_diligence_paid_initialization_work(integer)',
];

const expectedTableNames = [
  'public.form_payment_completion_retry',
  'public.form_paid_pipeline_operation',
];

function executable(name) {
  const result = spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    ...options,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function runResult(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    ...options,
  });
}

function spawnResult(command, args, options = {}) {
  return new Promise(resolve => {
    const child = spawn(command, args, {
      ...options,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdin.end(options.input || '');
    child.on('close', (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const initdb = executable('initdb');
const pgCtl = executable('pg_ctl');
const psqlBin = executable('psql');
if (!initdb || !pgCtl || !psqlBin) {
  console.log('Task #4446 isolated PostgreSQL tests skipped: local PostgreSQL tools unavailable');
  process.exit(0);
}

const root = await mkdtemp(path.join(tmpdir(), 'task4446-pg-'));
const data = path.join(root, 'data');
const socket = path.join(root, 'socket');
const log = path.join(root, 'postgres.log');
const port = String(24000 + (process.pid % 10000));
const conn = [
  '-h', socket,
  '-p', port,
  '-U', 'postgres',
  '-d', 'postgres',
  '--no-psqlrc',
  '-v', 'ON_ERROR_STOP=1',
  '-q',
];
const failures = [];

function check(condition, message) {
  if (!condition) failures.push(message);
}

function psql(sql, extraArgs = []) {
  return run(psqlBin, [...conn, ...extraArgs], { input: sql });
}

function psqlResult(sql, extraArgs = []) {
  return runResult(psqlBin, [...conn, ...extraArgs], { input: sql });
}

function scalar(sql) {
  return psql(sql, ['-At']).trim();
}

function firstScalarLine(output) {
  return output.split(/\s+/).map(value => value.trim()).find(Boolean) || '';
}

const fixtureSql = `
CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role;

CREATE TABLE public.form (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL,
  due_diligence_required BOOLEAN DEFAULT FALSE,
  form_type TEXT,
  survey_settings JSONB
);

CREATE TABLE public.form_submission (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL,
  form_id UUID,
  is_anonymous BOOLEAN DEFAULT FALSE,
  payment_provider TEXT,
  payment_status TEXT,
  payment_paid_at TIMESTAMPTZ,
  payment_meta JSONB NOT NULL DEFAULT '{}'::JSONB,
  submission_email_state JSONB
  ,created_member_id UUID
  ,created_organization_id UUID
  ,organization_id UUID
);

CREATE TABLE public.form_stripe_address_mapping_retry (
  form_submission_id UUID PRIMARY KEY REFERENCES public.form_submission(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claimed_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE public.form_stripe_address_mapping_ledger (
  form_submission_id UUID PRIMARY KEY REFERENCES public.form_submission(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL,
  member_id UUID,
  organization_id UUID,
  mappings JSONB,
  stripe_billing_address JSONB
);

CREATE TABLE public.form_due_diligence_initialization (
  form_submission_id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL,
  paid_eligible BOOLEAN NOT NULL DEFAULT FALSE,
  state TEXT NOT NULL DEFAULT 'queued',
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE public.form_due_diligence_one_off_ready (
  form_submission_id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL,
  ready_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE public.form_due_diligence_one_off_ready_recovery (
  form_submission_id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL,
  state TEXT NOT NULL DEFAULT 'processing',
  lease_token UUID NOT NULL DEFAULT gen_random_uuid(),
  lease_expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '10 minutes',
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_error TEXT
);
`;

const behavioralFixtureSql = `
BEGIN;
INSERT INTO public.form_submission
  (id, tenant_id, payment_provider, payment_status, payment_paid_at, payment_meta, submission_email_state)
VALUES
  ('10000000-0000-4000-8000-000000000001',
   '00000000-0000-4000-8000-000000000001', 'stripe', 'paid', NOW(),
   '{"completion":{"status":"processing","owner_token":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}}',
   '{}'),
  ('10000000-0000-4000-8000-000000000002',
   '00000000-0000-4000-8000-000000000001', 'stripe', 'paid', NOW(),
   '{"membership":true}', '{}'),
  ('10000000-0000-4000-8000-000000000003',
   '00000000-0000-4000-8000-000000000001', 'stripe', 'paid', NOW(),
   '{"completion":{"version":1,"status":"queued"}}', '{}'),
  ('10000000-0000-4000-8000-000000000004',
   '00000000-0000-4000-8000-000000000001', 'stripe', 'paid', NOW(),
   '{"completion":{"version":1,"status":"queued"}}', '{}'),
  ('10000000-0000-4000-8000-000000000005',
   '00000000-0000-4000-8000-000000000001', 'stripe', 'paid', NOW(),
   '{}',
   '{"status":"processing","claim_id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","claimed_at":"2000-01-01T00:00:00Z"}'),
  ('10000000-0000-4000-8000-000000000006',
   '00000000-0000-4000-8000-000000000001', 'stripe_monthly_card', 'setup_complete', NOW(),
    '{}', '{}');
INSERT INTO public.form_payment_completion_retry (form_submission_id, tenant_id, next_attempt_at)
VALUES
  ('10000000-0000-4000-8000-000000000003',
   '00000000-0000-4000-8000-000000000001', NOW());
DO $$
DECLARE
  v_bool BOOLEAN;
  v_json JSONB;
  v_owner UUID;
  v_count INTEGER;
  v_status TEXT;
BEGIN
  SELECT finish_form_payment_completion(
    '00000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000001',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'done'
  ) INTO v_bool;
  IF v_bool THEN RAISE EXCEPTION 'completion accepted wrong tenant'; END IF;

  SELECT finish_form_payment_completion(
    '00000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'done'
  ) INTO v_bool;
  IF v_bool THEN RAISE EXCEPTION 'completion accepted stale owner'; END IF;

  SELECT finish_form_payment_completion(
    '00000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'done'
  ) INTO v_bool;
  IF NOT v_bool THEN RAISE EXCEPTION 'completion rejected current owner'; END IF;

  SELECT payment_meta->'completion'->>'status'
    INTO v_status FROM public.form_submission
   WHERE id = '10000000-0000-4000-8000-000000000001';
  IF v_status <> 'done' THEN RAISE EXCEPTION 'completion status is %', v_status; END IF;

  SELECT capture_form_stripe_billing_address_once(
    '00000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000006',
    '{"line1":"monthly snapshot"}'::JSONB
  ) INTO v_json;
  IF v_json->'stripe_billing_address'->>'line1' <> 'monthly snapshot'
    THEN RAISE EXCEPTION 'monthly setup address was not captured'; END IF;

  SELECT c.lease_token INTO v_owner
    FROM claim_form_stripe_address_mapping_retries(20) AS c;
  IF v_owner IS NULL THEN RAISE EXCEPTION 'address retry did not claim'; END IF;

  PERFORM finish_form_stripe_address_mapping_retry(
    '00000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000002',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', FALSE, 'wrong owner'
  );
  SELECT count(*) INTO v_count
    FROM public.form_stripe_address_mapping_retry
   WHERE form_submission_id = '10000000-0000-4000-8000-000000000002'
     AND owner_token = v_owner;
  IF v_count <> 1 THEN RAISE EXCEPTION 'wrong address owner changed retry'; END IF;

  SELECT capture_form_stripe_billing_address_once(
    '00000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000002',
    '{"line1":"first snapshot"}'::JSONB
  ) INTO v_json;
  PERFORM finish_form_stripe_address_mapping_retry(
    '00000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000002',
    v_owner, TRUE
  );
  SELECT count(*) INTO v_count
    FROM public.form_stripe_address_mapping_retry
   WHERE form_submission_id = '10000000-0000-4000-8000-000000000002';
  IF v_count <> 0 THEN RAISE EXCEPTION 'address retry was not completed'; END IF;

  -- Snapshot capture cannot retire configured mappings: a mapping write that
  -- fails after capture must be claimable again until the atomic ledger exists.
  INSERT INTO public.form_submission
    (id, tenant_id, payment_provider, payment_status, payment_paid_at, payment_meta)
  VALUES
    ('10000000-0000-4000-8000-000000000007',
     '00000000-0000-4000-8000-000000000001', 'stripe', 'paid', NOW(),
     '{"stripe_billing_address":{"line1":"captured"},"stripe_address_mapping_config":{"mappings":[{"target_entity":"member"}]}}');
  SELECT c.lease_token INTO v_owner
    FROM claim_form_stripe_address_mapping_retries(20) AS c
   WHERE c.submission->>'id' = '10000000-0000-4000-8000-000000000007';
  IF v_owner IS NULL THEN RAISE EXCEPTION 'captured mapping was not claimed'; END IF;
  PERFORM finish_form_stripe_address_mapping_retry(
    '00000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000007', v_owner, FALSE, 'mapping failed after snapshot'
  );
  UPDATE public.form_stripe_address_mapping_retry
     SET next_attempt_at = NOW()
   WHERE form_submission_id = '10000000-0000-4000-8000-000000000007';
  SELECT c.lease_token INTO v_owner
    FROM claim_form_stripe_address_mapping_retries(20) AS c
   WHERE c.submission->>'id' = '10000000-0000-4000-8000-000000000007';
  IF v_owner IS NULL THEN RAISE EXCEPTION 'captured mapping was not reclaimable'; END IF;
  INSERT INTO public.form_submission
    (id, tenant_id, payment_provider, payment_status, payment_paid_at, payment_meta)
  VALUES
    ('10000000-0000-4000-8000-000000000008',
     '00000000-0000-4000-8000-000000000001', 'stripe_monthly_card', 'setup_complete', NOW(),
     '{"stripe_billing_address":{"line1":"monthly captured"},"stripe_address_mapping_config":{"mappings":[{"target_entity":"member"}]}}');
  SELECT count(*) INTO v_count
    FROM claim_form_stripe_address_mapping_retries(20) AS c
   WHERE c.submission->>'id' = '10000000-0000-4000-8000-000000000008';
  IF v_count <> 1 THEN RAISE EXCEPTION 'monthly card mapping was not eligible'; END IF;

  SELECT count(*) INTO v_count
    FROM claim_form_payment_completion_retries(20);
  IF v_count <> 1 THEN RAISE EXCEPTION 'expected one completion retry, got %', v_count; END IF;
  SELECT finish_form_payment_completion_retry(
    '00000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000003', 'done'
  ) INTO v_bool;
  IF v_bool THEN RAISE EXCEPTION 'wrong retry tenant succeeded'; END IF;
  SELECT finish_form_payment_completion_retry(
    '00000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000003', 'retryable', 'temporary'
  ) INTO v_bool;
  IF NOT v_bool THEN RAISE EXCEPTION 'retryable completion finish failed'; END IF;

  SELECT begin_form_paid_pipeline_operation(
    '00000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000004',
    'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
  )->>'status' INTO v_status;
  IF v_status <> 'claimed' THEN RAISE EXCEPTION 'pipeline claim is %', v_status; END IF;
  BEGIN
    PERFORM begin_form_paid_pipeline_operation(
      '00000000-0000-0000-8000-000000000004',
      '10000000-0000-4000-8000-000000000004',
      'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
    );
    RAISE EXCEPTION 'wrong pipeline tenant accepted';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;

  SELECT begin_form_paid_pipeline_operation(
    '00000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000004',
    'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
  )->>'status' INTO v_status;
  IF v_status <> 'processing' THEN RAISE EXCEPTION 'competing pipeline claim is %', v_status; END IF;

  SELECT finish_form_paid_pipeline_operation(
    '00000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000004',
    'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'done'
  ) INTO v_bool;
  IF v_bool THEN RAISE EXCEPTION 'wrong pipeline owner finished'; END IF;
  SELECT finish_form_paid_pipeline_operation(
    '00000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000004',
    'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'done'
  ) INTO v_bool;
  IF NOT v_bool THEN RAISE EXCEPTION 'pipeline owner did not finish'; END IF;
  -- A new ordinary completion owner must reuse the known durable result, not
  -- replay the processor. Only a persisted partial marker authorizes a
  -- specifically-scoped follow-up operation.
  SELECT begin_form_paid_pipeline_operation(
    '00000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000004',
    'ffffffff-ffff-4fff-8fff-ffffffffffff', 'primary'
  )->>'status' INTO v_status;
  IF v_status <> 'done' THEN RAISE EXCEPTION 'ordinary completed replay is %', v_status; END IF;
  UPDATE public.form_submission SET payment_meta =
    jsonb_set(payment_meta, '{structured_actions_pending}', 'true'::jsonb)
   WHERE id = '10000000-0000-4000-8000-000000000004';
  SELECT begin_form_paid_pipeline_operation(
    '00000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000004',
    'ffffffff-ffff-4fff-8fff-ffffffffffff', 'followup'
  )->>'status' INTO v_status;
  IF v_status <> 'claimed' THEN RAISE EXCEPTION 'authorized partial followup is %', v_status; END IF;
  SELECT finish_form_paid_pipeline_operation(
    '00000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000004',
    'ffffffff-ffff-4fff-8fff-ffffffffffff', 'done'
  ) INTO v_bool;
  IF NOT v_bool THEN RAISE EXCEPTION 'authorized followup did not finish'; END IF;

  SELECT mark_stale_submission_email_attention(
    '10000000-0000-4000-8000-000000000005',
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
  )->>'status' INTO v_status;
  IF v_status <> 'attention' THEN RAISE EXCEPTION 'stale email status is %', v_status; END IF;
END $$;
ROLLBACK;
`;

let started = false;
try {
  run('mkdir', ['-p', socket]);
  run(initdb, ['-D', data, '-A', 'trust', '-U', 'postgres', '--no-instructions']);
  run(pgCtl, [
    '-D', data,
    '-l', log,
    '-o', `-F -k ${socket} -c listen_addresses= -p ${port}`,
    '-w', 'start',
  ]);
  started = true;
  psql(fixtureSql);

  run(psqlBin, [...conn, '-f', migrationPaths[0]]);
  const ownerAcl = scalar(`
    SELECT has_function_privilege('anon',
      'public.finish_form_payment_completion(uuid,uuid,uuid,text,text,text)', 'EXECUTE')
      || ':' || has_function_privilege('anon',
      'public.capture_form_stripe_billing_address_once(uuid,uuid,jsonb)', 'EXECUTE')
  `);
  check(ownerAcl === 'false:false', `owner migration ACL expected false:false, got ${ownerAcl}`);

  run(psqlBin, [...conn, '-f', migrationPaths[1]]);
  const addressAcl = scalar(`
    SELECT has_function_privilege('anon',
      'public.claim_form_stripe_address_mapping_retries(integer)', 'EXECUTE')
      || ':' || has_function_privilege('anon',
      'public.finish_form_stripe_address_mapping_retry(uuid,uuid,boolean,text)', 'EXECUTE')
  `);
  check(addressAcl === 'false:false', `address migration ACL expected false:false, got ${addressAcl}`);

  run(psqlBin, [...conn, '-f', migrationPaths[2]]);
  run(psqlBin, [...conn, '-f', migrationPaths[3]]);
  run(psqlBin, [...conn, '-f', migrationPaths[4]]);
  console.log('full migration chain applied in isolated PostgreSQL');

  const aclSql = `
    SELECT
      count(*) FILTER (WHERE has_function_privilege('anon', rpc, 'EXECUTE')),
      count(*) FILTER (WHERE has_function_privilege('authenticated', rpc, 'EXECUTE')),
      count(*) FILTER (WHERE NOT has_function_privilege('service_role', rpc, 'EXECUTE'))
    FROM unnest(ARRAY[${rpcSignatures.map(signature => `'${signature}'`).join(',')}]) AS r(rpc)
  `;
  const aclCounts = scalar(aclSql).split('|').map(Number);
  check(aclCounts.length === 3, `unexpected final RPC ACL output: ${aclCounts.join('|')}`);
  check(aclCounts[0] === 0, `final anon RPC ACL leaks: ${aclCounts[0]}`);
  check(aclCounts[1] === 0, `final authenticated RPC ACL leaks: ${aclCounts[1]}`);
  check(aclCounts[2] === 0, `service_role RPC grants missing: ${aclCounts[2]}`);

  const tableAcl = scalar(`
    SELECT
      count(*) FILTER (WHERE has_table_privilege('anon', table_name, 'SELECT')),
      count(*) FILTER (WHERE NOT has_table_privilege('service_role', table_name, 'SELECT'))
    FROM unnest(ARRAY[${expectedTableNames.map(name => `'${name}'`).join(',')}]) AS t(table_name)
  `).split('|').map(Number);
  check(tableAcl[0] === 0, `final anon table ACL leaks: ${tableAcl[0]}`);
  check(tableAcl[1] === 0, `service_role table grants missing: ${tableAcl[1]}`);

  psql(behavioralFixtureSql);
  console.log('transactional owner/tenant behavior: PASS');

  const anonCall = psqlResult(`
    SET ROLE anon;
    SELECT queue_form_payment_completion(
      '00000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000099'
    );
  `);
  check(anonCall.status !== 0, 'anon could invoke a server-only completion RPC');

  psql(`
    INSERT INTO public.form_submission
      (id, tenant_id, payment_provider, payment_status, payment_meta)
    VALUES
      ('10000000-0000-4000-8000-000000000010',
       '00000000-0000-4000-8000-000000000001', 'stripe', 'pending', '{}');
  `);
  const serviceCall = psqlResult(`
    SET ROLE service_role;
    SELECT queue_form_payment_completion(
      '00000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000010'
    );
  `);
  check(serviceCall.status === 0, `service_role completion RPC failed: ${serviceCall.stderr}`);

  psql(`
    INSERT INTO public.form_submission
      (id, tenant_id, payment_provider, payment_status, payment_meta)
    VALUES
      ('10000000-0000-4000-8000-000000000007',
       '00000000-0000-4000-8000-000000000001', 'stripe', 'paid',
       '{"completion":{"version":1,"status":"queued"}}'),
      ('10000000-0000-4000-8000-000000000008',
       '00000000-0000-4000-8000-000000000001', 'stripe', 'paid',
       '{"membership":true}'),
      ('10000000-0000-4000-8000-000000000009',
       '00000000-0000-4000-8000-000000000001', 'stripe', 'paid',
       '{"completion":{"status":"processing","owner_token":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}}');
    INSERT INTO public.form_payment_completion_retry (form_submission_id, tenant_id, next_attempt_at)
    VALUES ('10000000-0000-4000-8000-000000000007',
            '00000000-0000-4000-8000-000000000001', NOW());
    INSERT INTO public.form_stripe_address_mapping_retry (form_submission_id, tenant_id, next_attempt_at)
    VALUES ('10000000-0000-4000-8000-000000000008',
            '00000000-0000-4000-8000-000000000001', NOW());
  `);

  const paymentClaimOne = spawnResult(psqlBin, [...conn, '-At'], {
    input: 'BEGIN; SELECT count(*) FROM claim_form_payment_completion_retries(1); SELECT pg_sleep(1); COMMIT;',
  });
  await sleep(150);
  const paymentClaimTwo = psqlResult('SELECT count(*) FROM claim_form_payment_completion_retries(1);', ['-At']);
  const paymentOneResult = await paymentClaimOne;
  check(firstScalarLine(paymentOneResult.stdout) === '1', `payment first claim was ${paymentOneResult.stdout}`);
  check(paymentClaimTwo.stdout.trim() === '0', `payment second claim was ${paymentClaimTwo.stdout}`);

  const addressClaimOne = spawnResult(psqlBin, [...conn, '-At'], {
    input: 'BEGIN; SELECT count(*) FROM claim_form_stripe_address_mapping_retries(1); SELECT pg_sleep(1); COMMIT;',
  });
  await sleep(150);
  const addressClaimTwo = psqlResult('SELECT count(*) FROM claim_form_stripe_address_mapping_retries(1);', ['-At']);
  const addressOneResult = await addressClaimOne;
  check(firstScalarLine(addressOneResult.stdout) === '1', `address first claim was ${addressOneResult.stdout}`);
  check(addressClaimTwo.stdout.trim() === '0', `address second claim was ${addressClaimTwo.stdout}`);

  const ownerOne = spawnResult(psqlBin, [...conn, '-At'], {
    input: `SELECT finish_form_payment_completion(
      '00000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000009',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'done');`,
  });
  const ownerTwo = spawnResult(psqlBin, [...conn, '-At'], {
    input: `SELECT finish_form_payment_completion(
      '00000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000009',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'done');`,
  });
  const [ownerOneResult, ownerTwoResult] = await Promise.all([ownerOne, ownerTwo]);
  const ownerResults = [
    ownerOneResult.stdout.trim(),
    ownerTwoResult.stdout.trim(),
  ];
  check(ownerResults.filter(result => result === 't').length === 1,
    `completion owner race results were ${ownerResults.join(',')}`);
  check(ownerResults.filter(result => result === 'f').length === 1,
    `completion owner race did not fence loser: ${ownerResults.join(',')}`);
  check(
    scalar(`SELECT payment_meta->'completion'->>'status'
              FROM public.form_submission
             WHERE id = '10000000-0000-4000-8000-000000000009'`) === 'done',
    'completion owner race did not produce done state',
  );
  console.log('SKIP LOCKED and owner races: PASS');
  const tenant = '00000000-0000-4000-8000-000000000001';
  const submission = '10000000-0000-4000-8000-000000000088';
  const firstOwner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const nextOwner = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const observe = (owner, kind = 'primary') =>
    `SELECT observe_or_begin_form_paid_pipeline_operation('${tenant}', '${submission}', '${owner}', '${kind}')->>'status'`;
  psql(`INSERT INTO form_submission(id,tenant_id,payment_status,payment_meta)
    VALUES('${submission}','${tenant}','paid',
    '{"completion":{"version":1,"status":"processing","owner_token":"${firstOwner}"}}');`);
  assert.equal(scalar(observe(firstOwner)), 'claimed');
  const marker = scalar(`SELECT payment_meta->'completion'->'awaiting_pipeline' FROM form_submission WHERE id='${submission}'`);
  assert.equal(JSON.parse(marker).operation_id, firstOwner);
  assert.equal(scalar(`SELECT finish_form_payment_completion('${tenant}','${submission}','${firstOwner}','retryable')`), 't');
  // Same JSON merge as the application's optimistic completion claim.
  psql(`UPDATE form_submission SET payment_meta=jsonb_set(payment_meta,'{completion}',
    (payment_meta->'completion') || '{"status":"processing","owner_token":"${nextOwner}"}')
    WHERE id='${submission}';`);
  assert.equal(scalar(`SELECT payment_meta->'completion'->'awaiting_pipeline' FROM form_submission WHERE id='${submission}'`), marker);
  assert.equal(scalar(observe(firstOwner)), 'attention', 'stale receipt owner fenced');
  assert.equal(scalar(observe(nextOwner)), 'waiting', 'new owner observes rather than replays');
  assert.equal(scalar(`SELECT finish_form_paid_pipeline_operation('${tenant}','${submission}','${nextOwner}','done')`), 'f');
  assert.equal(scalar(`SELECT finish_form_paid_pipeline_operation('${tenant}','${submission}','${firstOwner}','done')`), 't');
  assert.equal(scalar(observe(nextOwner)), 'done', 'late same-operation success resumes');
  assert.equal(scalar(`SELECT payment_meta->'completion' ? 'awaiting_pipeline' FROM form_submission WHERE id='${submission}'`), 'f');
  assert.equal(scalar(observe(nextOwner)), 'done', 'duplicate resume does not replay');
  // Known partial done may authorize exactly one NEW follow-up, and its marker
  // is consumed on completion instead of trapping subsequent work in a loop.
  psql(`UPDATE form_submission SET payment_meta=payment_meta || '{"stripe_address_mappings_pending":true}' WHERE id='${submission}';`);
  assert.equal(scalar(observe(nextOwner, 'followup')), 'claimed');
  assert.equal(scalar(observe(nextOwner, 'followup')), 'waiting');
  assert.equal(scalar(`SELECT finish_form_paid_pipeline_operation('${tenant}','${submission}','${nextOwner}','done')`), 't');
  assert.equal(scalar(observe(nextOwner, 'followup')), 'done');
  assert.equal(scalar(observe(nextOwner, 'followup')), 'done');
  // Terminal failed operation is not revived merely because a member exists.
  psql(`UPDATE form_paid_pipeline_operation SET status='attention' WHERE form_submission_id='${submission}';
    UPDATE form_submission SET created_member_id=gen_random_uuid(),
    payment_meta=jsonb_set(payment_meta,'{completion,awaiting_pipeline}',
      '{"operation_id":"${nextOwner}","expires_at":"2099-01-01T00:00:00Z"}') WHERE id='${submission}';`);
  assert.equal(scalar(observe(nextOwner)), 'attention');
  psql(`UPDATE form_paid_pipeline_operation SET status='processing' WHERE form_submission_id='${submission}';
    UPDATE form_submission SET payment_meta=jsonb_set(payment_meta,'{completion,awaiting_pipeline,expires_at}',
      '"2000-01-01T00:00:00Z"') WHERE id='${submission}';`);
  assert.equal(scalar(observe(nextOwner)), 'attention', 'observation is bounded');
  psql(`UPDATE form_submission SET payment_meta=jsonb_set(payment_meta,'{completion,status}','"attention"') WHERE id='${submission}';
    UPDATE form_paid_pipeline_operation SET status='done' WHERE form_submission_id='${submission}';`);
  assert.equal(scalar(observe(nextOwner)), 'attention', 'historical receipt is never recovered');
  // Competing sessions block on the receipt row; they cannot reserve another
  // operation while a completion owner is in its atomic observation section.
  const locked = spawnResult(psqlBin, [...conn, '-At'], {
    input: `BEGIN; SELECT id FROM form_submission WHERE id='${submission}' FOR UPDATE; SELECT pg_sleep(1); COMMIT;`,
  });
  await sleep(150);
  const blocked = psqlResult(`SET lock_timeout='100ms'; ${observe(nextOwner)};`);
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /lock timeout/);
  assert.equal((await locked).status, 0);
  console.log('late-success identity, bounded wait, partial, marker persistence, history and locking: PASS');
} catch (error) {
  failures.push(error?.stack || String(error));
} finally {
  if (started) {
    runResult(pgCtl, ['-D', data, '-m', 'immediate', '-w', 'stop'], { encoding: 'utf8' });
  }
  await rm(root, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error('\nTask #4446 isolated checks FAILED:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log('Task #4446 isolated checks passed.');
}