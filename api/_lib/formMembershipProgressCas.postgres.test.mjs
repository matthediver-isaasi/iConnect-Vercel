import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const migration = fileURLToPath(new URL(
  '../../supabase/migrations/20261017_form_membership_progress_cas.sql',
  import.meta.url,
));
const executable = (name) => spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).stdout.trim();
const run = (command, args, input = '') => {
  const result = spawnSync(command, args, { input, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
};

test('membership progress merge is atomic and preserves unrelated metadata', async (t) => {
  const initdb = executable('initdb');
  const pgCtl = executable('pg_ctl');
  const psql = executable('psql');
  if (!initdb || !pgCtl || !psql) return t.skip('local PostgreSQL tools unavailable');
  const root = await mkdtemp(path.join(tmpdir(), 'form-membership-cas-'));
  const data = path.join(root, 'data');
  const socket = path.join(root, 'socket');
  run('mkdir', ['-p', socket]);
  run(initdb, ['-D', data, '--no-locale', '--encoding=UTF8', '--auth=trust', '-U', 'postgres']);
  run(pgCtl, ['-D', data, '-l', path.join(root, 'postgres.log'), '-o', `-k ${socket}`, '-w', 'start']);
  const args = ['-h', socket, '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'];
  try {
    run(psql, args, `
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE TABLE form_submission(
        id uuid PRIMARY KEY, tenant_id uuid, payment_provider text, payment_status text,
        payment_reference text, payment_meta jsonb, created_member_id uuid, organization_id uuid
      );
      CREATE TABLE member_membership_history(
        id uuid PRIMARY KEY, tenant_id uuid, member_id uuid, stripe_payment_intent_id text,
        payment_status text, billing_agreement_id uuid, accounting_provider text,
        accounting_invoice_id text, accounting_invoice_number text,
        xero_invoice_id text, xero_invoice_number text
      );
      CREATE TABLE organisation_membership_history(
        id uuid PRIMARY KEY, tenant_id uuid, organization_id uuid, stripe_payment_intent_id text,
        payment_status text, billing_agreement_id uuid, accounting_provider text,
        accounting_invoice_id text, accounting_invoice_number text,
        xero_invoice_id text, xero_invoice_number text
      );
      \\i ${migration}
      INSERT INTO form_submission VALUES(
        '20000000-0000-4000-8000-000000000001',
        '10000000-0000-4000-8000-000000000001','stripe','paid','pi_1',
        '{"other":{"kept":true},"membership":{"quote":{"target":"member"}},"membership_result":{"workflow_state":"pending"}}',
        '30000000-0000-4000-8000-000000000001',NULL
      );
    `);
    const first = run(psql, [...args, '-t', '-A'], `
      SELECT merge_form_membership_result(
        '10000000-0000-4000-8000-000000000001',
        '20000000-0000-4000-8000-000000000001',
        '{"workflow_state":"claimed","workflow_claimed_at":"claim-1"}',
        '{"workflow_state":"pending"}')->>'ok';
    `);
    assert.equal(first, 'true');
    const lost = run(psql, [...args, '-t', '-A'], `
      SELECT merge_form_membership_result(
        '10000000-0000-4000-8000-000000000001',
        '20000000-0000-4000-8000-000000000001',
        '{"workflow_state":"done"}',
        '{"workflow_state":"claimed","workflow_claimed_at":"wrong"}')->>'code';
    `);
    assert.equal(lost, 'PROGRESS_CHANGED');
    const preserved = run(psql, [...args, '-t', '-A'], `
      SELECT payment_meta->'other'->>'kept' FROM form_submission;
    `);
    assert.equal(preserved, 'true');
    run(psql, args, `
      INSERT INTO member_membership_history VALUES(
        '40000000-0000-4000-8000-000000000001',
        '10000000-0000-4000-8000-000000000001',
        '30000000-0000-4000-8000-000000000001','pi_1','paid',NULL,
        NULL,NULL,NULL,NULL,NULL
      );
      UPDATE form_submission SET payment_meta = jsonb_set(payment_meta,
        '{membership_result}',
        '{"history_id":"40000000-0000-4000-8000-000000000001","entity_id":"30000000-0000-4000-8000-000000000001","invoice_state":"processing","invoice_claimed_at":"claim-invoice","accounting_provider":"xero","provider_context":{"xero_tenant_id":"remote-1"}}');
    `);
    const wrongLink = run(psql, [...args, '-t', '-A'], `
      SELECT link_recovered_form_membership_invoice(
        '10000000-0000-4000-8000-000000000001',
        '20000000-0000-4000-8000-000000000001',
        '40000000-0000-4000-8000-000000000001',
        'invoice-1','INV-1','xero','{"xero_tenant_id":"remote-1"}','wrong')->>'code';
    `);
    assert.equal(wrongLink, 'PROGRESS_CHANGED');
    const linked = run(psql, [...args, '-t', '-A'], `
      SELECT link_recovered_form_membership_invoice(
        '10000000-0000-4000-8000-000000000001',
        '20000000-0000-4000-8000-000000000001',
        '40000000-0000-4000-8000-000000000001',
        'invoice-1','INV-1','xero','{"xero_tenant_id":"remote-1"}','claim-invoice')->>'ok';
    `);
    assert.equal(linked, 'true');
    assert.equal(run(psql, [...args, '-t', '-A'], `
      SELECT accounting_invoice_id || ':' ||
        (SELECT payment_meta->'membership_result'->>'settlement_state' FROM form_submission)
      FROM member_membership_history;
    `), 'invoice-1:pending');
  } finally {
    spawnSync(pgCtl, ['-D', data, '-m', 'immediate', 'stop']);
    await rm(root, { recursive: true, force: true });
  }
});