import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const migration = fileURLToPath(new URL(
  '../../supabase/migrations/20261112_form_monthly_card_state_cas.sql',
  import.meta.url,
));
const executable = (name) => spawnSync(
  'sh',
  ['-c', `command -v ${name}`],
  { encoding: 'utf8' },
).stdout.trim();
const run = (command, args, input = '') => {
  const result = spawnSync(command, args, { input, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
};

test('monthly-card state RPC body CAS preserves large metadata and owner fences', async (t) => {
  const initdb = executable('initdb');
  const pgCtl = executable('pg_ctl');
  const psql = executable('psql');
  if (!initdb || !pgCtl || !psql) return t.skip('local PostgreSQL tools unavailable');

  const root = await mkdtemp(path.join(tmpdir(), 'monthly-card-state-cas-'));
  const data = path.join(root, 'data');
  const socket = path.join(root, 'socket');
  run('mkdir', ['-p', socket]);
  run(initdb, ['-D', data, '--no-locale', '--encoding=UTF8', '--auth=trust', '-U', 'postgres']);
  run(pgCtl, ['-D', data, '-l', path.join(root, 'postgres.log'), '-o', `-k ${socket}`, '-w', 'start']);
  const args = ['-h', socket, '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'];
  try {
    run(psql, args, `
      CREATE ROLE anon;
      CREATE ROLE authenticated;
      CREATE ROLE service_role;
      CREATE TABLE public.form_submission(
        id UUID PRIMARY KEY,
        payment_status TEXT NOT NULL,
        payment_meta JSONB NOT NULL,
        processing_notes TEXT
      );
      GRANT SELECT, UPDATE ON public.form_submission TO service_role;
      \\i ${migration}
      INSERT INTO public.form_submission(id, payment_status, payment_meta)
      VALUES (
        '20000000-0000-4000-8000-000000000001',
        'setup_complete',
        jsonb_build_object(
          'large_pipeline_result', repeat('x', 22000),
          'unrelated', jsonb_build_object('kept', true),
          'monthly_card_state', jsonb_build_object(
            'status', 'processing',
            'claimed_at', '2026-01-01T00:00:00.000Z',
            'owner_token', 'old-owner'
          )
        )
      );
    `);

    const signature = 'uuid,jsonb,jsonb,boolean,text,text,boolean,text,text,text,boolean';
    assert.equal(run(psql, [...args, '-t', '-A'], `
      SELECT has_function_privilege('service_role',
        'public.cas_form_monthly_card_state(${signature})', 'EXECUTE') || ':' ||
        has_function_privilege('authenticated',
        'public.cas_form_monthly_card_state(${signature})', 'EXECUTE');
    `), 'true:false');

    const fenced = run(psql, [...args, '-t', '-A'], `
      SET ROLE service_role;
      SELECT public.cas_form_monthly_card_state(
        id, payment_meta,
        '{"status":"done"}'::jsonb,
        false, 'setup_complete', 'processing', false, null, 'wrong-owner',
        null, false
      )
      FROM public.form_submission
      WHERE id = '20000000-0000-4000-8000-000000000001';
    `).split('\n').at(-1);
    assert.equal(fenced, 'f');

    const updated = run(psql, [...args, '-t', '-A'], `
      SET ROLE service_role;
      SELECT public.cas_form_monthly_card_state(
        id, payment_meta,
        '{"status":"processing","claimed_at":"2026-01-02T00:00:00.000Z","owner_token":"new-owner"}'::jsonb,
        false, 'setup_complete', 'processing', false,
        '2026-01-01T00:00:00.000Z', 'old-owner', null, false
      )
      FROM public.form_submission
      WHERE id = '20000000-0000-4000-8000-000000000001';
    `).split('\n').at(-1);
    assert.equal(updated, 't');

    assert.equal(run(psql, [...args, '-t', '-A'], `
      SELECT
        (payment_meta->'unrelated'->>'kept') || ':' ||
        length(payment_meta->>'large_pipeline_result') || ':' ||
        (payment_meta->'monthly_card_state'->>'owner_token')
      FROM public.form_submission;
    `), 'true:22000:new-owner');

    const exactMetaLoss = run(psql, [...args, '-t', '-A'], `
      SET ROLE service_role;
      SELECT public.cas_form_monthly_card_state(
        id,
        payment_meta || '{"concurrent_pipeline_write":true}'::jsonb,
        '{"status":"done"}'::jsonb,
        false, 'setup_complete', 'processing', false, null, 'new-owner',
        null, false
      )
      FROM public.form_submission
      WHERE id = '20000000-0000-4000-8000-000000000001';
    `).split('\n').at(-1);
    assert.equal(exactMetaLoss, 'f');
  } finally {
    spawnSync(pgCtl, ['-D', data, '-m', 'immediate', 'stop']);
    await rm(root, { recursive: true, force: true });
  }
});