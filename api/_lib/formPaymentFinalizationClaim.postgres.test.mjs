import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const executable = name => spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).stdout.trim();
const run = (command, args, input = '') => {
  const result = spawnSync(command, args, { input, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
};

test('payment finalization body CAS returns scalar JSONB and preserves exact snapshots', async () => {
  const initdb = executable('initdb'), pgCtl = executable('pg_ctl'), psql = executable('psql');
  assert.ok(initdb && pgCtl && psql, 'Isolated PostgreSQL tools required; no remote fallback');
  const root = await mkdtemp(path.join(tmpdir(), 'form-payment-finalization-cas-'));
  const data = path.join(root, 'data'), socket = path.join(root, 'socket');
  await mkdir(socket);
  let started = false;
  try {
    run(initdb, ['-D', data, '--no-locale', '--encoding=UTF8', '--auth=trust', '-U', 'postgres']);
    run(pgCtl, ['-D', data, '-l', path.join(root, 'postgres.log'), '-o', `-k ${socket} -c listen_addresses=''`, '-w', 'start']);
    started = true;
    const args = ['-X', '-h', socket, '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', '-t', '-A'];
    const sql = statement => run(psql, args, statement);
    const migration = fileURLToPath(new URL('../../supabase/migrations/20261114_form_payment_finalization_claim_body_cas.sql', import.meta.url));
    const tenant = '10000000-0000-4000-8000-000000000001';
    const stripe = '20000000-0000-4000-8000-000000000001';
    const gc = '20000000-0000-4000-8000-000000000002';
    const owner = '30000000-0000-4000-8000-000000000001';
    sql(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE TABLE form_submission (
        id UUID PRIMARY KEY,
        tenant_id UUID NOT NULL,
        payment_status TEXT NOT NULL,
        payment_provider TEXT,
        payment_meta JSONB NOT NULL DEFAULT '{}'::JSONB,
        processing_notes JSONB,
        submission_data JSONB,
        payment_paid_at TIMESTAMPTZ
      );
      \\i ${migration}
      INSERT INTO form_submission(id,tenant_id,payment_status,payment_provider,payment_meta,processing_notes)
      VALUES
        ('${stripe}','${tenant}','paid','stripe',
          jsonb_build_object('large',repeat('x',20480),'completion',
            '{"version":1,"status":"queued","attempts":0}'::jsonb),
          '[{"kind":"existing"}]'::jsonb),
        ('${gc}','${tenant}','paid','gocardless',
          jsonb_build_object('large',repeat('z',20480)),
          '[{"kind":"existing"}]'::jsonb);
    `);

    const expectedStripe = sql(`SELECT payment_meta::text FROM form_submission WHERE id='${stripe}';`);
    const claimed = JSON.parse(sql(`
      SET ROLE service_role;
      SELECT claim_form_payment_finalization(
        '${tenant}','${stripe}',${`$meta$${expectedStripe}$meta$`}::jsonb,
        '2026-11-14T12:00:00Z','${owner}')::text;
    `));
    assert.equal(Array.isArray(claimed), false, 'PostgREST-compatible result is a scalar JSON object');
    assert.equal(claimed.id, stripe);
    assert.equal(claimed.payment_meta.large.length, 20480);
    assert.equal(claimed.payment_meta.completion.owner_token, owner);
    assert.equal(claimed.payment_meta.completion.attempts, 1);
    assert.equal(sql(`SELECT pg_typeof(claim_form_payment_finalization(
      '${tenant}','${stripe}',payment_meta,now(),'30000000-0000-4000-8000-000000000002'))
      FROM form_submission WHERE id='${stripe}';`), 'jsonb');

    // Two contenders holding the same original snapshot cannot both win.
    assert.equal(sql(`SELECT claim_form_payment_finalization(
      '${tenant}','${stripe}',${`$meta$${expectedStripe}$meta$`}::jsonb,
      '2026-11-14T12:00:01Z','30000000-0000-4000-8000-000000000003') IS NULL;`), 't');

    // A sibling metadata write invalidates the stale snapshot and survives.
    const expectedGc = sql(`SELECT payment_meta::text FROM form_submission WHERE id='${gc}';`);
    sql(`UPDATE form_submission SET payment_meta=payment_meta||'{"webhook":{"preserve":true}}' WHERE id='${gc}';`);
    assert.equal(sql(`SELECT claim_form_payment_finalization(
      '${tenant}','${gc}',${`$meta$${expectedGc}$meta$`}::jsonb,
      '2026-11-14T12:00:00Z',NULL) IS NULL;`), 't');
    const freshGc = sql(`SELECT payment_meta::text FROM form_submission WHERE id='${gc}';`);
    const legacy = JSON.parse(sql(`SELECT claim_form_payment_finalization(
      '${tenant}','${gc}',${`$meta$${freshGc}$meta$`}::jsonb,
      '2026-11-14T12:00:00Z',NULL)::text;`));
    assert.equal(legacy.payment_meta.webhook.preserve, true);
    assert.equal(legacy.payment_meta.finalized, true);
    assert.equal(legacy.processing_notes[0].kind, 'existing');

    const invalid = spawnSync(psql, args, {
      input: `SET ROLE service_role; SELECT claim_form_payment_finalization(
        '${tenant}','${stripe}','{"completion":null}'::jsonb,now(),'${owner}');`,
      encoding: 'utf8',
    });
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /invalid completion form payment finalization snapshot/);

    const unauthorized = spawnSync(psql, args, {
      input: `SET ROLE authenticated; SELECT claim_form_payment_finalization(
        '${tenant}','${stripe}','{}'::jsonb,now(),NULL);`,
      encoding: 'utf8',
    });
    assert.notEqual(unauthorized.status, 0);
    assert.match(unauthorized.stderr, /permission denied/);
  } finally {
    if (started) run(pgCtl, ['-D', data, '-m', 'immediate', '-w', 'stop']);
    await rm(root, { recursive: true, force: true });
  }
});