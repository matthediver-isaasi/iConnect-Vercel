import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const originalMigration = fileURLToPath(new URL(
  '../../supabase/migrations/20261112_form_monthly_card_state_cas.sql',
  import.meta.url,
));
const correctiveMigration = fileURLToPath(new URL(
  '../../supabase/migrations/20261113_form_monthly_card_state_cas_jsonb_notes.sql',
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
const runRaw = (command, args, input = '') => spawnSync(
  command,
  args,
  { input, encoding: 'utf8' },
);

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
        processing_notes JSONB
      );
      GRANT SELECT, UPDATE ON public.form_submission TO service_role;
      \\i ${originalMigration}
      INSERT INTO public.form_submission(id, payment_status, payment_meta, processing_notes)
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
        ),
        '[{"kind":"pipeline_warning","message":"preserve me"}]'::jsonb
      );
    `);

    const broken = runRaw(psql, [...args, '-t', '-A'], `
      \\set VERBOSITY verbose
      SET ROLE service_role;
      SELECT public.cas_form_monthly_card_state(
        id, payment_meta,
        '{"status":"processing","claimed_at":"2026-01-02T00:00:00.000Z","owner_token":"new-owner"}'::jsonb,
        false, 'setup_complete', 'processing', false,
        '2026-01-01T00:00:00.000Z', 'old-owner', null, false
      )
      FROM public.form_submission
      WHERE id = '20000000-0000-4000-8000-000000000001';
    `);
    assert.notEqual(broken.status, 0);
    assert.match(broken.stderr, /42804/);
    assert.match(broken.stderr, /column "processing_notes" is of type jsonb|CASE types jsonb and text/i);

    run(psql, args, `\\i ${correctiveMigration}`);

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
    assert.equal(run(psql, [...args, '-t', '-A'], `
      SELECT processing_notes =
        '[{"kind":"pipeline_warning","message":"preserve me"}]'::jsonb
      FROM public.form_submission;
    `), 't');

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

    const renewed = run(psql, [...args, '-t', '-A'], `
      SET ROLE service_role;
      SELECT public.cas_form_monthly_card_state(
        id, payment_meta,
        '{"status":"processing","claimed_at":"2026-01-02T00:05:00.000Z","owner_token":"new-owner"}'::jsonb,
        false, 'setup_complete', 'processing', false,
        '2026-01-02T00:00:00.000Z', 'new-owner', null, false
      )
      FROM public.form_submission
      WHERE id = '20000000-0000-4000-8000-000000000001';
    `).split('\n').at(-1);
    assert.equal(renewed, 't');
    assert.equal(run(psql, [...args, '-t', '-A'], `
      SELECT processing_notes =
        '[{"kind":"pipeline_warning","message":"preserve me"}]'::jsonb
      FROM public.form_submission;
    `), 't');

    const done = run(psql, [...args, '-t', '-A'], `
      SET ROLE service_role;
      SELECT public.cas_form_monthly_card_state(
        id, payment_meta,
        '{"status":"done","done_at":"2026-01-03T00:00:00.000Z"}'::jsonb,
        false, 'setup_complete', 'processing', false, null, 'new-owner',
        null, false
      )
      FROM public.form_submission
      WHERE id = '20000000-0000-4000-8000-000000000001';
    `).split('\n').at(-1);
    assert.equal(done, 't');
    assert.equal(run(psql, [...args, '-t', '-A'], `
      SELECT processing_notes =
        '[{"kind":"pipeline_warning","message":"preserve me"}]'::jsonb
      FROM public.form_submission;
    `), 't');

    run(psql, args, `
      INSERT INTO public.form_submission(id, payment_status, payment_meta, processing_notes)
      VALUES
        ('20000000-0000-4000-8000-000000000002', 'setup_complete',
         '{"monthly_card_state":{"status":"processing","claimed_at":"old","owner_token":"owner-2"}}',
         '{"kind":"legacy_object","message":"object kept"}'),
        ('20000000-0000-4000-8000-000000000003', 'setup_complete',
         '{"monthly_card_state":{"status":"processing","claimed_at":"old","owner_token":"owner-3"}}',
         '"legacy string kept"'),
        ('20000000-0000-4000-8000-000000000004', 'setup_complete',
         '{"monthly_card_state":{"status":"processing","claimed_at":"old","owner_token":"owner-4"}}',
         NULL);
    `);
    for (const suffix of ['2', '3', '4']) {
      const conflicted = run(psql, [...args, '-t', '-A'], `
        SET ROLE service_role;
        SELECT public.cas_form_monthly_card_state(
          id, payment_meta,
          '{"status":"conflict","code":"MEMBERSHIP_YEAR_EXISTS","detail":"Already recorded","member_id":"30000000-0000-4000-8000-000000000001","detected_at":"2026-01-04T00:00:00.000Z"}'::jsonb,
          false, 'setup_complete', 'processing', false, null, 'owner-${suffix}',
          '[object Object]\nAlready recorded. The Stripe subscription will be cancelled.',
          true
        )
        FROM public.form_submission
        WHERE id = '20000000-0000-4000-8000-00000000000${suffix}';
      `).split('\n').at(-1);
      assert.equal(conflicted, 't');
    }
    assert.equal(run(psql, [...args, '-t', '-A'], `
      SELECT string_agg(
        jsonb_typeof(processing_notes) || ':' ||
        jsonb_array_length(processing_notes) || ':' ||
        (processing_notes->-1->>'kind') || ':' ||
        (processing_notes->-1->>'message'),
        '|'
        ORDER BY id
      )
      FROM public.form_submission
      WHERE id IN (
        '20000000-0000-4000-8000-000000000002',
        '20000000-0000-4000-8000-000000000003',
        '20000000-0000-4000-8000-000000000004'
      );
    `), [
      'array:2:monthly_card_membership_conflict:Already recorded. The Stripe subscription will be cancelled.',
      'array:2:monthly_card_membership_conflict:Already recorded. The Stripe subscription will be cancelled.',
      'array:1:monthly_card_membership_conflict:Already recorded. The Stripe subscription will be cancelled.',
    ].join('|'));
    assert.equal(run(psql, [...args, '-t', '-A'], `
      SELECT
        (SELECT processing_notes->0->>'kind' FROM public.form_submission
          WHERE id = '20000000-0000-4000-8000-000000000002') || ':' ||
        (SELECT processing_notes->0->>'message' FROM public.form_submission
          WHERE id = '20000000-0000-4000-8000-000000000003');
    `), 'legacy_object:legacy string kept');
  } finally {
    spawnSync(pgCtl, ['-D', data, '-m', 'immediate', 'stop']);
    await rm(root, { recursive: true, force: true });
  }
});