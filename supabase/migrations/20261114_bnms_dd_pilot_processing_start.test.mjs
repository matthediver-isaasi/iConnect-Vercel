import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { createLocalPostgresHarness } from '../../scripts/test-support/local-postgres-harness.mjs';

test('pilot processing guard: London boundary, provider evidence, existing reservations and unrelated plans', { timeout: 45000 }, async () => {
  const harness = await createLocalPostgresHarness('pilot-processing-');
  const { root, data, socket } = harness;
  const run = (cmd, args, input) => {
    const r = spawnSync(cmd, args, { input, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    return r.stdout;
  };
  const conn = ['-h', socket, '-p', String(harness.port), '-U', 'postgres', '-d', 'postgres', '-X', '-v', 'ON_ERROR_STOP=1', '-At'];
  const sql = input => run('psql', conn, input);
  const failure = (input, pattern) => {
    const r = spawnSync('psql', conn, { input, encoding: 'utf8' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, pattern);
  };
  let started = false;
  try {
    run('initdb', ['-D', data, '-A', 'trust', '-U', 'postgres']);
    run('pg_ctl', ['-D', data, '-l', path.join(root, 'postgres.log'), '-o', `-F -k ${socket} -c listen_addresses= -p ${harness.port}`, '-w', 'start']);
    started = true;
    const tenant = 'ff2df806-b321-4254-b651-3af11fccf1db';
    const member = '33e5d54d-162e-436d-9bff-ec6676d198f9';
    const id = '00000000-0000-4000-8000-000000000001';
    sql(`
      CREATE TABLE bnms_dd_pilot_adoption(id uuid,plan_id uuid,tenant_id uuid,member_id uuid);
      CREATE TABLE bnms_dd_pilot_release(adoption_id uuid,tenant_id uuid,member_id uuid);
      CREATE TABLE gocardless_collection_reservations(plan_id uuid,tenant_id uuid,collection_number integer,
        due_date date,requested_charge_date date,amount_minor integer,currency text,provider_evidence jsonb);
      INSERT INTO bnms_dd_pilot_adoption VALUES('${id}','${id}','${tenant}','${member}');
      INSERT INTO bnms_dd_pilot_release VALUES('${id}','${tenant}','${member}');
      CREATE FUNCTION public.test_clock() RETURNS timestamptz LANGUAGE sql AS
        $$ SELECT current_setting('test.clock')::timestamptz $$;
    `);
    const migration = readFileSync(new URL('./20261114_bnms_dd_pilot_processing_start.sql', import.meta.url), 'utf8');
    sql(`BEGIN;${migration}COMMIT;`); // Exact production SQL compiles on isolated PostgreSQL.
    // Only this disposable fixture replaces the clock, enabling deterministic
    // before/at/after-boundary tests without changing production clock authority.
    sql(`BEGIN;${migration.replaceAll('clock_timestamp()', 'public.test_clock()')}COMMIT;`);
    const insert = (date = '2026-10-07', checked = '2026-09-30T23:00:00Z', plan = id) => `
      INSERT INTO gocardless_collection_reservations VALUES('${plan}','${tenant}',1,'2026-10-01','${date}',1300,'GBP',
      '{"status":"active","next_possible_charge_date":"${date}","checked_at":"${checked}"}');`;
    failure(`SET test.clock='2026-09-30T22:59:59.999Z';${insert()}`, /processing-not-before/);
    sql(`SET test.clock='2026-09-30T22:59:59Z';${insert('2026-10-07', undefined, '00000000-0000-4000-8000-000000000002')}`);
    failure(`SET test.clock='2026-09-30T23:00:00Z';${insert('2026-10-07','2026-09-30T22:59:59Z')}`, /post-gate provider date evidence/);
    failure(`SET test.clock='2026-09-30T23:00:00Z';${insert('2026-10-09')}`, /post-gate provider date evidence/);
    failure(`SET test.clock='2026-10-08T12:00:00Z';${insert()}`, /in the past/);
    sql(`SET test.clock='2026-09-30T23:00:00Z';${insert()}`);
    failure(`SET test.clock='2026-09-30T22:59:59Z';UPDATE gocardless_collection_reservations SET amount_minor=1300 WHERE plan_id='${id}';`, /processing-not-before/);
    failure(`BEGIN;${migration}COMMIT;`, /reservations already exist/);
    sql(`SET test.clock='2026-10-10T12:00:00Z';UPDATE gocardless_collection_reservations SET amount_minor=1300 WHERE plan_id='${id}';`);
    failure(`SET test.clock='2026-10-01T12:00:00Z';UPDATE gocardless_collection_reservations SET amount_minor=1304 WHERE plan_id='${id}';`, /post-gate provider date evidence/);
    sql('DELETE FROM bnms_dd_pilot_release;');
    failure(`SET test.clock='2026-10-01T12:00:00Z';${insert()}`, /not been explicitly released/);
  } finally {
    if (started) run('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop']);
    await harness.cleanup();
  }
});