import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const migrationPath = fileURLToPath(
  new URL('../../supabase/migrations/20260907_sales_foundation.sql', import.meta.url),
);

function findExecutable(name) {
  const result = spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    ...options,
  });
  assert.equal(
    result.status,
    0,
    `${path.basename(command)} failed:\n${result.stderr || result.stdout}`,
  );
  return result.stdout;
}

function runFailure(command, args, expectedError, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    ...options,
  });
  assert.notEqual(result.status, 0, `${path.basename(command)} unexpectedly succeeded`);
  assert.match(result.stderr || result.stdout, expectedError);
}

function runAsync(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      ...options,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(options.input || '');
  });
}

test('Sales migration enforces fail-closed roles, atomic numbers, and immutable audit', {
  timeout: 30_000,
}, async (t) => {
  const initdb = findExecutable('initdb');
  const pgCtl = findExecutable('pg_ctl');
  const psql = findExecutable('psql');
  if (!initdb || !pgCtl || !psql) {
    t.skip('PostgreSQL command-line tools are unavailable');
    return;
  }

  const root = await mkdtemp(path.join(tmpdir(), 'sales-foundation-'));
  const dataDir = path.join(root, 'data');
  const socketDir = path.join(root, 'socket');
  run('mkdir', ['-p', socketDir]);
  let started = false;
  const connectionArgs = [
    '-h', socketDir,
    '-p', '5432',
    '-U', 'postgres',
    '-d', 'postgres',
    '--no-psqlrc',
    '-v', 'ON_ERROR_STOP=1',
    '-q',
  ];

  try {
    run(initdb, ['-D', dataDir, '-A', 'trust', '-U', 'postgres', '--no-instructions']);
    run(pgCtl, [
      '-D', dataDir,
      '-l', path.join(root, 'postgres.log'),
      '-o', `-F -k ${socketDir} -c listen_addresses= -p 5432`,
      '-w',
      'start',
    ]);
    started = true;

    run(psql, connectionArgs, {
      input: `
        CREATE ROLE anon;
        CREATE ROLE authenticated;
        CREATE ROLE service_role;
        CREATE TABLE public.tenant (id uuid PRIMARY KEY);
        CREATE TABLE public.role (
          id uuid PRIMARY KEY,
          tenant_id uuid NOT NULL REFERENCES public.tenant(id),
          excluded_features text[]
        );
        INSERT INTO public.tenant(id) VALUES
          ('00000000-0000-4000-8000-000000000001'),
          ('00000000-0000-4000-8000-000000000002');
        INSERT INTO public.role(id, tenant_id, excluded_features) VALUES
          ('10000000-0000-4000-8000-000000000001',
           '00000000-0000-4000-8000-000000000001', ARRAY['content']),
          ('10000000-0000-4000-8000-000000000002',
           '00000000-0000-4000-8000-000000000002', NULL);
      `,
    });
    run(psql, [...connectionArgs, '-f', migrationPath]);

    const excluded = run(psql, [...connectionArgs, '-t', '-A'], {
      input: `
        SELECT bool_and(COALESCE(excluded_features, ARRAY[]::text[]) @> ARRAY['sales'])
        FROM public.role;
      `,
    });
    assert.equal(excluded.trim(), 't');

    runFailure(psql, connectionArgs, /permission denied/, {
      input: `
        SET ROLE authenticated;
        SELECT * FROM public.sales_settings;
      `,
    });
    runFailure(psql, connectionArgs, /permission denied/, {
      input: `
        SET ROLE authenticated;
        SELECT * FROM public.allocate_sales_identifier(
          '00000000-0000-4000-8000-000000000001', 'quote', 'attacker', 'member'
        );
      `,
    });

    const allocations = await Promise.all(Array.from({ length: 20 }, (_, index) => (
      runAsync(psql, [...connectionArgs, '-t', '-A'], {
        input: `
          SELECT identifier || ':' || sequence_value
          FROM public.allocate_sales_identifier(
            '00000000-0000-4000-8000-000000000001',
            'quote',
            'actor-${index}',
            'member'
          );
        `,
      })
    )));
    for (const allocation of allocations) {
      assert.equal(allocation.status, 0, allocation.stderr);
    }
    const rows = allocations.map(({ stdout }) => stdout.trim());
    assert.equal(new Set(rows.map((row) => row.split(':')[0])).size, 20);
    assert.deepEqual(
      rows.map((row) => Number(row.split(':')[1])).sort((a, b) => a - b),
      Array.from({ length: 20 }, (_, index) => index + 1),
    );

    const foreign = run(psql, [...connectionArgs, '-t', '-A'], {
      input: `
        SELECT identifier || ':' || sequence_value
        FROM public.allocate_sales_identifier(
          '00000000-0000-4000-8000-000000000002',
          'quote',
          'foreign-actor',
          'tenant_user'
        );
      `,
    });
    assert.equal(foreign.trim(), 'Q000001:1');

    const audit = run(psql, [...connectionArgs, '-t', '-A'], {
      input: `
        SELECT count(*) || ':' || count(DISTINCT actor_id) || ':'
          || bool_and(tenant_id = '00000000-0000-4000-8000-000000000001')
        FROM public.sales_audit_event
        WHERE entity_type = 'sales_number_sequence'
          AND tenant_id = '00000000-0000-4000-8000-000000000001';
      `,
    });
    assert.equal(audit.trim(), '20:20:true');

    run(psql, connectionArgs, {
      input: `
        SELECT public.patch_sales_settings(
          '00000000-0000-4000-8000-000000000001',
          1,
          '{"quotePrefix":"S","defaultCurrency":"USD"}',
          'settings-admin',
          'tenant_user'
        );
      `,
    });
    const settingsAudit = run(psql, [...connectionArgs, '-t', '-A'], {
      input: `
        SELECT actor_id || ':' || actor_type || ':' || (after_data->>'default_currency')
        FROM public.sales_audit_event
        WHERE action = 'settings.updated';
      `,
    });
    assert.equal(settingsAudit.trim(), 'settings-admin:tenant_user:USD');

    runFailure(psql, connectionArgs, /Sales audit events are immutable/, {
      input: `UPDATE public.sales_audit_event SET action = 'tampered';`,
    });
    runFailure(psql, connectionArgs, /Sales audit events are immutable/, {
      input: `DELETE FROM public.sales_audit_event;`,
    });
  } finally {
    if (started) run(pgCtl, ['-D', dataDir, '-m', 'fast', '-w', 'stop']);
    await rm(root, { recursive: true, force: true });
  }
});