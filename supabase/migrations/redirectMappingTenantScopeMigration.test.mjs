import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { createLocalPostgresHarness } from '../../scripts/test-support/local-postgres-harness.mjs';

const migration = readFileSync(
  new URL('./20261120_redirect_mapping_tenant_scope.sql', import.meta.url),
  'utf8',
);

test('disposable PostgreSQL: redirect migration quarantines legacy rows and preserves tenant isolation', { timeout: 45_000 }, async () => {
  const h = await createLocalPostgresHarness('redirect-tenant-');
  const run = (command, args, input, expectFailure = false) => {
    const result = spawnSync(command, args, { input, encoding: 'utf8' });
    if (expectFailure) assert.notEqual(result.status, 0, 'statement should have failed');
    else assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout;
  };
  const sql = (input, expectFailure = false) => run(
    'psql',
    ['-h', h.socket, '-p', String(h.port), '-U', 'postgres', '-d', 'postgres',
      '-X', '-v', 'ON_ERROR_STOP=1', '-At'],
    input,
    expectFailure,
  );
  let started = false;
  try {
    run('initdb', ['-D', h.data, '-A', 'trust', '-U', 'postgres']);
    run('pg_ctl', ['-D', h.data, '-l', path.join(h.root, 'postgres.log'),
      '-o', `-F -k ${h.socket} -c listen_addresses= -p ${h.port}`, '-w', 'start']);
    started = true;

    sql(migration); // Safe before a fresh schema has created the table.

    const tenantA = '00000000-0000-0000-0000-000000000001';
    const tenantB = '00000000-0000-0000-0000-000000000002';
    sql(`
      CREATE TABLE tenant (id uuid PRIMARY KEY);
      INSERT INTO tenant VALUES ('${tenantA}'), ('${tenantB}');
      CREATE TABLE redirect_mapping (
        id uuid PRIMARY KEY,
        source_pattern text NOT NULL,
        target_url text NOT NULL,
        match_type text NOT NULL DEFAULT 'exact',
        status_code integer NOT NULL DEFAULT 301,
        priority integer NOT NULL DEFAULT 100,
        is_active boolean DEFAULT true
      );
      INSERT INTO redirect_mapping(id, source_pattern, target_url)
      VALUES ('10000000-0000-0000-0000-000000000001', '/legacy', '/old-home');
    `);

    sql(migration);
    sql(migration); // Replay is a no-op.

    assert.equal(
      sql("SELECT tenant_id IS NULL FROM redirect_mapping WHERE source_pattern='/legacy';").trim(),
      't',
      'ambiguous legacy ownership must never be guessed',
    );
    assert.equal(
      sql(`SELECT count(*) FROM redirect_mapping WHERE tenant_id='${tenantA}';`).trim(),
      '0',
      'unowned legacy rows must be quarantined from tenant reads',
    );
    sql(`INSERT INTO redirect_mapping(id, tenant_id, source_pattern, target_url)
      VALUES
      ('10000000-0000-0000-0000-000000000002','${tenantA}','/a','/'),
      ('10000000-0000-0000-0000-000000000003','${tenantB}','/b','/');`);
    sql(`UPDATE redirect_mapping SET priority=1 WHERE tenant_id='${tenantA}';`);
    assert.equal(
      sql(`SELECT string_agg(source_pattern, ',' ORDER BY source_pattern)
        FROM redirect_mapping WHERE priority=1;`).trim(),
      '/a',
      'tenant-scoped administration must not update another tenant or NULL rows',
    );
    assert.equal(
      sql(`SELECT source_pattern FROM redirect_mapping
        WHERE tenant_id='${tenantB}' AND priority=100;`).trim(),
      '/b',
    );
    sql(`INSERT INTO redirect_mapping(id, tenant_id, source_pattern, target_url)
      VALUES ('10000000-0000-0000-0000-000000000004',
        '00000000-0000-0000-0000-000000000099','/invalid','/');`, true);

    assert.equal(
      sql(`SELECT count(*) FROM pg_constraint
        WHERE conrelid='redirect_mapping'::regclass AND contype='f'
          AND confrelid='tenant'::regclass;`).trim(),
      '1',
    );
    assert.equal(
      sql(`SELECT count(*) FROM pg_indexes WHERE tablename='redirect_mapping'
        AND indexname IN ('idx_redirect_mapping_tenant_id',
          'idx_redirect_mapping_active_priority');`).trim(),
      '2',
    );
    assert.match(
      sql(`SELECT indexdef FROM pg_indexes
        WHERE indexname='idx_redirect_mapping_active_priority';`).trim(),
      /\(is_active, priority\) WHERE \(is_active = true\)$/,
    );

    // An already-current installation, including owned data and existing
    // indexes/FK, is unchanged by the migration.
    const before = sql('SELECT jsonb_agg(to_jsonb(r) ORDER BY id)::text FROM redirect_mapping r;').trim();
    sql(migration);
    assert.equal(
      sql('SELECT jsonb_agg(to_jsonb(r) ORDER BY id)::text FROM redirect_mapping r;').trim(),
      before,
    );
  } finally {
    if (started) run('pg_ctl', ['-D', h.data, '-m', 'immediate', '-w', 'stop']);
    await h.cleanup();
  }
});