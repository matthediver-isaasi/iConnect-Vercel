import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const migrationUrl = new URL('./20261017_form_stripe_address_mapping_processing.sql', import.meta.url);
const migrationPath = fileURLToPath(migrationUrl);
const sql = await readFile(migrationUrl, 'utf8');

function executable(name) {
  const found = spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' });
  return found.status === 0 ? found.stdout.trim() : null;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, ...options });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

test('Stripe address writes and completion ledger share one RPC transaction', () => {
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.apply_form_stripe_address_mappings/i);
  assert.match(sql, /FOR UPDATE/);
  assert.match(sql, /UPDATE public\.(member|organization)|EXECUTE format\('UPDATE public\./i);
  assert.match(sql, /INSERT INTO public\.form_stripe_address_mapping_ledger/i);
  assert.doesNotMatch(sql, /^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/im);
});

test('RPC revalidates payment lifecycle, provider, tenant, and snapshots', () => {
  assert.match(sql, /payment_provider NOT IN \('stripe', 'stripe_monthly_card'\)/);
  assert.match(sql, /payment_status <> 'paid'/);
  assert.match(sql, /paid_invoice_ids/);
  assert.match(sql, /tenant_id = p_tenant_id/);
  assert.match(sql, /PAYMENT_SNAPSHOT_MISMATCH/);
});

test('SECURITY DEFINER RPC is service-role only', () => {
  assert.match(sql, /SECURITY DEFINER/);
  assert.match(sql, /REVOKE ALL ON FUNCTION[\s\S]*FROM PUBLIC, anon, authenticated/i);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION[\s\S]*TO service_role/i);
});

test('RPC executes atomically, skips absent components, and replays from ledger', { timeout: 45_000 }, async (t) => {
  const initdb = executable('initdb');
  const pgCtl = executable('pg_ctl');
  const psql = executable('psql');
  if (!initdb || !pgCtl || !psql) return t.skip('PostgreSQL command-line tools are unavailable');

  const root = await mkdtemp(path.join(tmpdir(), 'stripe-address-rpc-'));
  const data = path.join(root, 'data');
  const socket = path.join(root, 'socket');
  run('mkdir', ['-p', socket]);
  const port = String(24000 + (process.pid % 10000));
  const conn = ['-h', socket, '-p', port, '-U', 'postgres', '-d', 'postgres', '--no-psqlrc', '-v', 'ON_ERROR_STOP=1', '-q'];
  let started = false;
  try {
    run(initdb, ['-D', data, '-A', 'trust', '-U', 'postgres', '--no-instructions']);
    run(pgCtl, ['-D', data, '-l', path.join(root, 'postgres.log'), '-o', `-F -k ${socket} -c listen_addresses= -p ${port}`, '-w', 'start']);
    started = true;
    run(psql, conn, { input: `
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE TABLE form_submission (
        id uuid PRIMARY KEY, tenant_id uuid NOT NULL, payment_provider text,
        payment_status text, submitted_by_email text, payment_meta jsonb NOT NULL DEFAULT '{}'
      );
      CREATE TABLE member (id uuid PRIMARY KEY, tenant_id uuid NOT NULL, email text, organization_id uuid);
      CREATE TABLE organization (id uuid PRIMARY KEY, tenant_id uuid NOT NULL, invoicing_address text);
      CREATE TABLE membership_payment_plans (billing_agreement_id uuid, metadata jsonb);
      CREATE TABLE preference_field (
        id uuid PRIMARY KEY, tenant_id uuid NOT NULL, is_active boolean,
        entity_scope text, field_type text, read_only boolean DEFAULT false,
        is_calculated boolean DEFAULT false, editable boolean DEFAULT true,
        formula text, calculation_config jsonb, selected_countries jsonb
      );
      CREATE TABLE member_preference_value (member_id uuid, field_id uuid, value text);
      CREATE TABLE organization_preference_value (organization_id uuid, field_id uuid, value text);
    ` });
    run(psql, [...conn, '-f', migrationPath]);
    const tenant = '00000000-0000-4000-8000-000000000001';
    const org = '10000000-0000-4000-8000-000000000001';
    const submission = '20000000-0000-4000-8000-000000000001';
    const textField = '30000000-0000-4000-8000-000000000001';
    const countryField = '30000000-0000-4000-8000-000000000002';
    const numberField = '30000000-0000-4000-8000-000000000003';
    const mappings = JSON.stringify([
      { source: 'formatted', target_entity: 'organization', target_type: 'core', target_field: 'invoicing_address' },
      { source: 'line2', target_entity: 'organization', target_type: 'custom', target_field: textField },
      { source: 'country', target_entity: 'organization', target_type: 'custom', target_field: countryField },
    ]).replaceAll("'", "''");
    const stripeAddress = JSON.stringify({
      line1: '10 High Street', line2: null, city: 'Leeds', state: null,
      postal_code: 'LS1 1AA', country: 'GB', formatted: '10 High Street\nLeeds\nLS1 1AA\nGB',
    }).replaceAll("'", "''");
    const mappedAddress = JSON.stringify({
      line1: '10 High Street', line2: null, city: 'Leeds', state: null,
      postal_code: 'LS1 1AA', country_code: 'GB', country: 'United Kingdom',
      formatted: '10 High Street\nLeeds\nLS1 1AA\nGB',
    }).replaceAll("'", "''");
    run(psql, conn, { input: `
      INSERT INTO organization VALUES ('${org}','${tenant}','old');
      INSERT INTO preference_field (id,tenant_id,is_active,entity_scope,field_type,selected_countries) VALUES
        ('${textField}','${tenant}',true,'organization','text',NULL),
        ('${countryField}','${tenant}',true,'organization','country','["GB"]'),
        ('${numberField}','${tenant}',true,'organization','number',NULL);
      INSERT INTO organization_preference_value VALUES ('${org}','${textField}','keep me');
      INSERT INTO form_submission VALUES (
        '${submission}','${tenant}','stripe','paid',NULL,
        jsonb_build_object(
          'stripe_address_mapping_config', jsonb_build_object('version',1,'mappings','${mappings}'::jsonb),
          'stripe_billing_address','${stripeAddress}'::jsonb
        )
      );
      INSERT INTO form_submission_entity_creation
        (form_submission_id,tenant_id,entity_type,entity_id)
        VALUES ('${submission}','${tenant}','organization','${org}');
    ` });
    const scalar = input => run(psql, [...conn, '-t', '-A'], { input });
    const leaseOne = '40000000-0000-4000-8000-000000000001';
    const leaseTwo = '40000000-0000-4000-8000-000000000002';
    assert.equal(scalar(`SELECT claim_form_stripe_address_mapping_processing(
      '${tenant}','${submission}','${leaseOne}')`), 't');
    assert.equal(scalar(`SELECT claim_form_stripe_address_mapping_processing(
      '${tenant}','${submission}','${leaseTwo}')`), 'f');
    scalar(`SELECT release_form_stripe_address_mapping_processing(
      '${tenant}','${submission}','${leaseOne}')`);
    assert.equal(scalar(`SELECT claim_form_stripe_address_mapping_processing(
      '${tenant}','${submission}','${leaseTwo}')`), 't');
    scalar(`SELECT release_form_stripe_address_mapping_processing(
      '${tenant}','${submission}','${leaseTwo}')`);

    // Queue fairness: completed history is excluded before LIMIT, and a full
    // batch of poison claims is backed off so later work progresses next run.
    const healthyQueuedSubmission = '20000000-0000-4000-8000-000000000099';
    run(psql, conn, { input: `
      UPDATE form_submission SET payment_status='pending' WHERE id='${submission}';
      INSERT INTO form_submission (id,tenant_id,payment_provider,payment_status,payment_meta)
      SELECT md5('completed-' || n)::uuid, '${tenant}', 'stripe', 'paid',
             '{"stripe_address_mapping_config":{"version":1,"mappings":[{}]}}'::jsonb
        FROM generate_series(1,25) n;
      INSERT INTO form_stripe_address_mapping_ledger
        (form_submission_id,tenant_id,mappings,stripe_billing_address)
      SELECT md5('completed-' || n)::uuid, '${tenant}', '[]'::jsonb, '{}'::jsonb
        FROM generate_series(1,25) n;

      INSERT INTO form_submission (id,tenant_id,payment_provider,payment_status,payment_meta)
      SELECT md5('poison-' || n)::uuid, '${tenant}', 'stripe', 'paid',
             '{"stripe_address_mapping_config":{"version":1,"mappings":[{}]}}'::jsonb
        FROM generate_series(1,21) n;
      INSERT INTO form_submission (id,tenant_id,payment_provider,payment_status,payment_meta)
      VALUES (
        '${healthyQueuedSubmission}','${tenant}','stripe','paid',
        '{"stripe_address_mapping_config":{"version":1,"mappings":[{}]}}'::jsonb
      );
      INSERT INTO form_stripe_address_mapping_retry
        (form_submission_id,tenant_id,created_at)
      SELECT md5('poison-' || n)::uuid, '${tenant}', '2020-01-01'::timestamptz + n * interval '1 second'
        FROM generate_series(1,21) n;
      INSERT INTO form_stripe_address_mapping_retry
        (form_submission_id,tenant_id,created_at)
      VALUES ('${healthyQueuedSubmission}','${tenant}','2030-01-01');
    ` });
    assert.equal(scalar(`SELECT count(*) FROM claim_form_stripe_address_mapping_retries(20)`), '20');
    assert.equal(scalar(`
      SELECT count(*) FROM form_stripe_address_mapping_retry retry
       WHERE retry.form_submission_id IN (
         SELECT md5('completed-' || n)::uuid FROM generate_series(1,25) n
       )
    `), '0');
    const secondClaim = scalar(`
      SELECT submission->>'id'
        FROM claim_form_stripe_address_mapping_retries(20)
       ORDER BY submission->>'id'
    `).split('\n');
    assert.equal(secondClaim.length, 2);
    assert.ok(secondClaim.includes(healthyQueuedSubmission));
    const eligibleMonthly = '20000000-0000-4000-8000-000000000095';
    run(psql, conn, { input: `
      INSERT INTO form_submission (id,tenant_id,payment_provider,payment_status,payment_meta) VALUES
        ('20000000-0000-4000-8000-000000000091','${tenant}','gocardless','paid',
          '{"stripe_address_mapping_config":{"version":1,"mappings":[{}]}}'),
        ('20000000-0000-4000-8000-000000000092','${tenant}','stripe','pending',
          '{"stripe_address_mapping_config":{"version":1,"mappings":[{}]}}'),
        ('20000000-0000-4000-8000-000000000093','${tenant}','stripe','paid','{}'),
        ('20000000-0000-4000-8000-000000000094','${tenant}','stripe_monthly_card','paid',
          '{"stripe_address_mapping_config":{"version":1,"mappings":[{}]}}'),
        ('${eligibleMonthly}','${tenant}','stripe_monthly_card','setup_complete',
          '{"stripe_address_mapping_config":{"version":1,"mappings":[{}]}}');
      INSERT INTO form_stripe_address_mapping_retry (form_submission_id,tenant_id)
      SELECT id, tenant_id FROM form_submission
       WHERE id IN (
         '20000000-0000-4000-8000-000000000091',
         '20000000-0000-4000-8000-000000000092',
         '20000000-0000-4000-8000-000000000093',
         '20000000-0000-4000-8000-000000000094',
         '${eligibleMonthly}'
       );
    ` });
    assert.equal(
      scalar(`SELECT submission->>'id' FROM claim_form_stripe_address_mapping_retries(20)`),
      eligibleMonthly,
    );
    assert.equal(scalar(`
      SELECT count(*) FROM form_stripe_address_mapping_retry
       WHERE form_submission_id IN (
         '20000000-0000-4000-8000-000000000091',
         '20000000-0000-4000-8000-000000000092',
         '20000000-0000-4000-8000-000000000093',
         '20000000-0000-4000-8000-000000000094'
       )
    `), '0');
    run(psql, conn, { input: `
      UPDATE form_submission SET payment_status='paid' WHERE id='${submission}';
    ` });

    const initialResult = scalar(`SELECT apply_form_stripe_address_mappings(
      '${tenant}','${submission}',NULL,'${org}','${mappings}'::jsonb,'${mappedAddress}'::jsonb
    )`);
    assert.match(initialResult, /"applied": true/);
    assert.equal(scalar(`SELECT invoicing_address FROM organization WHERE id='${org}'`), '10 High Street\nLeeds\nLS1 1AA\nGB');
    assert.equal(scalar(`SELECT value FROM organization_preference_value WHERE field_id='${textField}'`), 'keep me');
    assert.equal(scalar(`SELECT value FROM organization_preference_value WHERE field_id='${countryField}'`), 'United Kingdom');

    // A completed replay ignores deliberately drifted snapshots/targets.
    run(psql, conn, { input: `UPDATE organization SET invoicing_address='later edit' WHERE id='${org}'` });
    assert.match(scalar(`SELECT apply_form_stripe_address_mappings(
      '${tenant}','${submission}',NULL,NULL,'[]'::jsonb,'{}'::jsonb
    )`), /ALREADY_APPLIED/);
    assert.equal(scalar(`SELECT invoicing_address FROM organization WHERE id='${org}'`), 'later edit');

    // A late invalid mapping is rejected during prevalidation, before the
    // valid first mapping can mutate anything.
    const invalidSubmission = '20000000-0000-4000-8000-000000000003';
    const invalidMappings = JSON.stringify([
      { source: 'formatted', target_entity: 'organization', target_type: 'core', target_field: 'invoicing_address' },
      { source: 'city', target_entity: 'organization', target_type: 'custom', target_field: numberField },
    ]).replaceAll("'", "''");
    run(psql, conn, { input: `
      INSERT INTO form_submission VALUES (
        '${invalidSubmission}','${tenant}','stripe','paid',NULL,
        jsonb_build_object(
          'stripe_address_mapping_config',jsonb_build_object('version',1,'mappings','${invalidMappings}'::jsonb),
          'stripe_billing_address','${stripeAddress}'::jsonb
        )
      );
      INSERT INTO form_submission_entity_creation VALUES
        ('${invalidSubmission}','${tenant}','organization','${org}',NOW());
    ` });
    assert.match(scalar(`SELECT apply_form_stripe_address_mappings(
      '${tenant}','${invalidSubmission}',NULL,'${org}','${invalidMappings}'::jsonb,'${mappedAddress}'::jsonb
    )`), /CUSTOM_FIELD_NOT_ALLOWED/);
    assert.equal(scalar(`SELECT invoicing_address FROM organization WHERE id='${org}'`), 'later edit');
    assert.equal(scalar(`SELECT count(*) FROM form_stripe_address_mapping_ledger WHERE form_submission_id='${invalidSubmission}'`), '0');

    // A service-role RPC call cannot nominate an arbitrary same-tenant target.
    const unauthorizedSubmission = '20000000-0000-4000-8000-000000000004';
    run(psql, conn, { input: `
      INSERT INTO form_submission VALUES (
        '${unauthorizedSubmission}','${tenant}','stripe','paid',NULL,
        jsonb_build_object(
          'stripe_address_mapping_config',jsonb_build_object('version',1,'mappings','${mappings}'::jsonb),
          'stripe_billing_address','${stripeAddress}'::jsonb
        )
      );
    ` });
    assert.match(scalar(`SELECT apply_form_stripe_address_mappings(
      '${tenant}','${unauthorizedSubmission}',NULL,'${org}','${mappings}'::jsonb,'${mappedAddress}'::jsonb
    )`), /TARGET_MUTATION_FORBIDDEN/);
    assert.equal(scalar(`SELECT invoicing_address FROM organization WHERE id='${org}'`), 'later edit');

    // Country controls store the canonical name and enforce their ISO allowlist.
    const countrySubmission = '20000000-0000-4000-8000-000000000005';
    const countryMappings = JSON.stringify([
      { source: 'country', target_entity: 'organization', target_type: 'custom', target_field: countryField },
    ]).replaceAll("'", "''");
    run(psql, conn, { input: `
      UPDATE preference_field SET selected_countries='["US"]' WHERE id='${countryField}';
      INSERT INTO form_submission VALUES (
        '${countrySubmission}','${tenant}','stripe','paid',NULL,
        jsonb_build_object(
          'stripe_address_mapping_config',jsonb_build_object('version',1,'mappings','${countryMappings}'::jsonb),
          'stripe_billing_address','${stripeAddress}'::jsonb
        )
      );
      INSERT INTO form_submission_entity_creation VALUES
        ('${countrySubmission}','${tenant}','organization','${org}',NOW());
    ` });
    assert.match(scalar(`SELECT apply_form_stripe_address_mappings(
      '${tenant}','${countrySubmission}',NULL,'${org}','${countryMappings}'::jsonb,'${mappedAddress}'::jsonb
    )`), /COUNTRY_NOT_ALLOWED/);
    const readonlySubmission = '20000000-0000-4000-8000-000000000006';
    run(psql, conn, { input: `
      UPDATE preference_field SET selected_countries='["GB"]', read_only=true WHERE id='${countryField}';
      INSERT INTO form_submission VALUES (
        '${readonlySubmission}','${tenant}','stripe','paid',NULL,
        jsonb_build_object(
          'stripe_address_mapping_config',jsonb_build_object('version',1,'mappings','${countryMappings}'::jsonb),
          'stripe_billing_address','${stripeAddress}'::jsonb
        )
      );
      INSERT INTO form_submission_entity_creation VALUES
        ('${readonlySubmission}','${tenant}','organization','${org}',NOW());
    ` });
    assert.match(scalar(`SELECT apply_form_stripe_address_mappings(
      '${tenant}','${readonlySubmission}',NULL,'${org}','${countryMappings}'::jsonb,'${mappedAddress}'::jsonb
    )`), /CUSTOM_FIELD_NOT_ALLOWED/);
    run(psql, conn, { input: `UPDATE preference_field SET read_only=false WHERE id='${countryField}'` });

    // A late write failure rolls the earlier core update back and creates no ledger.
    const failedSubmission = '20000000-0000-4000-8000-000000000002';
    const failingMappings = JSON.stringify([
      { source: 'formatted', target_entity: 'organization', target_type: 'core', target_field: 'invoicing_address' },
      { source: 'country', target_entity: 'organization', target_type: 'custom', target_field: countryField },
    ]).replaceAll("'", "''");
    run(psql, conn, { input: `
      CREATE FUNCTION reject_country_write() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'forced preference failure'; END $$;
      CREATE TRIGGER reject_country BEFORE UPDATE OR INSERT ON organization_preference_value
        FOR EACH ROW WHEN (NEW.field_id='${countryField}'::uuid) EXECUTE FUNCTION reject_country_write();
      INSERT INTO form_submission VALUES (
        '${failedSubmission}','${tenant}','stripe','paid',NULL,
        jsonb_build_object(
          'stripe_address_mapping_config',jsonb_build_object('version',1,'mappings','${failingMappings}'::jsonb),
          'stripe_billing_address','${stripeAddress}'::jsonb
        )
      );
      INSERT INTO form_submission_entity_creation VALUES
        ('${failedSubmission}','${tenant}','organization','${org}',NOW());
    ` });
    const failure = spawnSync(psql, conn, {
      encoding: 'utf8',
      input: `SELECT apply_form_stripe_address_mappings(
        '${tenant}','${failedSubmission}',NULL,'${org}','${failingMappings}'::jsonb,'${mappedAddress}'::jsonb
      );`,
    });
    assert.notEqual(failure.status, 0);
    assert.match(failure.stderr, /forced preference failure/);
    assert.equal(scalar(`SELECT invoicing_address FROM organization WHERE id='${org}'`), 'later edit');
    assert.equal(scalar(`SELECT count(*) FROM form_stripe_address_mapping_ledger WHERE form_submission_id='${failedSubmission}'`), '0');
  } finally {
    if (started) spawnSync(pgCtl, ['-D', data, '-m', 'immediate', '-w', 'stop'], { encoding: 'utf8' });
    await rm(root, { recursive: true, force: true });
  }
});