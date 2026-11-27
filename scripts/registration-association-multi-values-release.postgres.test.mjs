import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import pg from 'pg';
import { buildRelease, REVIEW_SHA256 } from './registration-association-multi-values-release.mjs';

test('guarded release rehearses, installs once and verifies in disposable PostgreSQL', { timeout: 60000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'association-release-'));
  let db; let started = false;
  try {
    execFileSync('initdb', ['-D', join(root, 'data'), '-A', 'trust', '-U', 'runner', '--no-locale', '--encoding=UTF8'], { stdio: 'pipe' });
    execFileSync('pg_ctl', ['-D', join(root, 'data'), '-l', join(root, 'pg.log'), '-o', `-k ${root} -p 55564 -h ''`, '-w', 'start'], { stdio: 'pipe' });
    started = true;
    db = new pg.Client({ host: root, port: 55564, user: 'runner', database: 'postgres' });
    await db.connect();
    await db.query(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE TABLE event(id uuid,tenant_id uuid,status text);
      CREATE TABLE complex_event(LIKE event);
      CREATE FUNCTION assert_registration_account_association(uuid,jsonb) RETURNS boolean LANGUAGE sql AS 'SELECT true';
      CREATE FUNCTION provision_public_ticket_members(uuid) RETURNS boolean LANGUAGE sql AS 'SELECT true';
      CREATE FUNCTION insert_public_ticket_booking_batch(uuid,jsonb) RETURNS boolean LANGUAGE sql AS 'SELECT true';
      REVOKE ALL ON FUNCTION assert_registration_account_association(uuid,jsonb),
        provision_public_ticket_members(uuid),insert_public_ticket_booking_batch(uuid,jsonb) FROM PUBLIC;
      GRANT EXECUTE ON FUNCTION assert_registration_account_association(uuid,jsonb),
        provision_public_ticket_members(uuid),insert_public_ticket_booking_batch(uuid,jsonb) TO service_role;
    `);
    for (const file of [
      '202612090005_event_registration_associations.sql',
      '202612090009_registration_association_value_scope.sql',
      '202612090010_registration_association_complete_options.sql',
      '202612090011_registration_association_exclude_zombie.sql',
    ]) await db.query(await readFile(new URL(`../supabase/migrations/${file}`, import.meta.url), 'utf8'));
    // Match the existing destination guard grant; the release must preserve it.
    await db.query('GRANT EXECUTE ON FUNCTION guard_registration_association_config() TO service_role');
    const payload = async mode => (await buildRelease(['--approved', `--review-sha256=${REVIEW_SHA256}`, `--mode=${mode}`])).query;
    const original = (await db.query("SELECT pg_get_functiondef('event_registration_association_options(uuid,uuid,boolean,text,text,uuid)'::regprocedure) AS definition")).rows;
    await db.query(await payload('rehearse'));
    assert.equal((await db.query("SELECT to_regprocedure('registration_association_values_match(text,jsonb)') AS helper")).rows[0].helper, null);
    assert.deepEqual((await db.query("SELECT pg_get_functiondef('event_registration_association_options(uuid,uuid,boolean,text,text,uuid)'::regprocedure) AS definition")).rows, original);
    await db.query(await payload('install'));
    const verified = await db.query(await payload('verify'));
    assert.ok(verified.some(result => result.rows?.[0]?.verification?.roleExecutionChecked));
    await assert.rejects(db.query(await payload('install')), /already exists/);
    await db.query('ROLLBACK');
    await db.query("CREATE OR REPLACE FUNCTION registration_association_values_match(p_stored text,p_values jsonb) RETURNS boolean LANGUAGE sql AS 'SELECT true'");
    await assert.rejects(db.query(await payload('verify')), /Installed helper differs/);
    await db.query('ROLLBACK');
  } finally {
    await db?.end().catch(() => {});
    if (started) execFileSync('pg_ctl', ['-D', join(root, 'data'), '-m', 'immediate', '-w', 'stop'], { stdio: 'pipe' });
    await rm(root, { recursive: true, force: true });
  }
});
