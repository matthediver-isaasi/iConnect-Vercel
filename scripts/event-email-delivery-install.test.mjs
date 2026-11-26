import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { createLocalPostgresHarness } from './test-support/local-postgres-harness.mjs';
import { managedInstallQuery, destination, reviewedSha256 } from './event-email-delivery-install.mjs';

test('managed installer pins destination/hash and preserves an existing installation', async () => {
  assert.throws(() => managedInstallQuery({ projectId: 'other', reviewSha256: reviewedSha256 }));
  assert.throws(() => managedInstallQuery({ projectId: destination, reviewSha256: 'other' }));
  const query = managedInstallQuery({ projectId: destination, reviewSha256: reviewedSha256 });
  assert.ok(!query.includes('CREATE TABLE IF NOT EXISTS public.event_email_resend_claim'));
  const h = await createLocalPostgresHarness('event-email-install-');
  let started = false;
  const run = (command, args, input) => {
    const result = spawnSync(command, args, { input, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const args = ['-h', h.socket, '-p', String(h.port), '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-At'];
  const sql = input => run('psql', args, input);
  try {
    run('initdb', ['-D', h.data, '-A', 'trust', '-U', 'postgres']);
    run('pg_ctl', ['-D', h.data, '-l', path.join(h.root, 'postgres.log'),
      '-o', `-F -k ${h.socket} -c listen_addresses= -p ${h.port}`, '-w', 'start']);
    started = true;
    sql(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE TABLE tenant(id uuid,name text); CREATE TABLE event(id uuid,tenant_id uuid);
      INSERT INTO tenant VALUES('ff2df806-b321-4254-b651-3af11fccf1db','BNMS');
      INSERT INTO event VALUES('1fb90343-a129-4fcf-affd-07db4d572a51','ff2df806-b321-4254-b651-3af11fccf1db');`);
    // Transactional rehearsal leaves no objects.
    sql(`BEGIN; ${query} ROLLBACK;`);
    assert.equal(sql("SELECT to_regclass('public.event_email_delivery') IS NULL"), 't');
    // Incompatible partial state is never overwritten.
    sql('CREATE TABLE event_email_delivery_tracking(incompatible text)');
    assert.notEqual(spawnSync('psql', args, { input: query }).status, 0);
    sql('DROP TABLE event_email_delivery_tracking');
    sql(query);
    const timestamp = sql('SELECT started_at FROM event_email_delivery_tracking');
    assert.notEqual(spawnSync('psql', args, { input: query }).status, 0);
    assert.equal(sql('SELECT started_at FROM event_email_delivery_tracking'), timestamp);
    assert.equal(sql("SELECT to_regclass('public.event_email_resend_claim') IS NULL"), 't');
    // Each installed RPC is exactly the definition from the reviewed source.
    const before = sql(`SELECT md5(string_agg(pg_get_functiondef(oid),'' ORDER BY proname))
      FROM pg_proc WHERE proname IN ('record_event_email_send_result','apply_event_email_delivery_event','event_email_delivery_stats')`);
    sql(readFileSync('supabase/migrations/202702010001_event_email_delivery.sql', 'utf8'));
    assert.equal(sql(`SELECT md5(string_agg(pg_get_functiondef(oid),'' ORDER BY proname))
      FROM pg_proc WHERE proname IN ('record_event_email_send_result','apply_event_email_delivery_event','event_email_delivery_stats')`), before);
  } finally {
    if (started) spawnSync('pg_ctl', ['-D', h.data, '-m', 'immediate', 'stop']);
    await h.cleanup();
  }
});
