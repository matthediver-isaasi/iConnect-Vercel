import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import pg from 'pg';
import { createLocalPostgresHarness } from '../../scripts/test-support/local-postgres-harness.mjs';

test('survey deletion atomically removes answers/counts but preserves completion evidence', { timeout: 120000 }, async () => {
  const h = await createLocalPostgresHarness('survey-delete-');
  const cmd = (name, args) => {
    const result = spawnSync(name, args, { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  let db, started = false;
  try {
    cmd('initdb', ['-D', h.data, '-A', 'trust', '-U', 'postgres']);
    cmd('pg_ctl', ['-D', h.data, '-l', path.join(h.root, 'postgres.log'),
      '-o', `-F -k ${h.socket} -c listen_addresses= -p ${h.port}`, '-w', 'start']);
    started = true;
    db = new pg.Client({ host: h.socket, port: h.port, user: 'postgres', database: 'postgres' });
    await db.connect();
    await db.query(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE TABLE form_submission(id integer PRIMARY KEY, tenant_id integer, survey_assignment_id integer, created_date timestamptz DEFAULT now());
      CREATE TABLE survey_answer(submission_id integer, tenant_id integer, raw_score numeric);
      CREATE TABLE event_survey_assignment(id integer PRIMARY KEY, tenant_id integer, response_count integer, updated_at timestamptz, first_response_at timestamptz, last_response_at timestamptz);
      CREATE TABLE certificate_survey_entitlement(response_id integer REFERENCES form_submission(id), completed_at timestamptz);
      INSERT INTO event_survey_assignment(id,tenant_id,response_count,updated_at) VALUES (10,1,2,now()),(20,2,1,now());
      INSERT INTO form_submission(id,tenant_id,survey_assignment_id) VALUES (1,1,10),(2,1,10),(3,2,20);
      INSERT INTO survey_answer VALUES (1,1,10),(2,1,4),(3,2,8);
      INSERT INTO certificate_survey_entitlement VALUES (1,'2026-10-01');
      GRANT SELECT, DELETE ON form_submission TO service_role;
      GRANT SELECT ON survey_answer,event_survey_assignment,certificate_survey_entitlement TO service_role;
    `);
    const migration = readFileSync('supabase/migrations/20261018_survey_response_deletion.sql', 'utf8');
    await db.query(migration);
    await db.query(migration);
    await db.query('SET ROLE service_role');
    await db.query('BEGIN');
    await db.query('DELETE FROM form_submission WHERE id=1 AND tenant_id=1');
    assert.equal((await db.query('SELECT sum(raw_score)::int score FROM survey_answer WHERE tenant_id=1')).rows[0].score, 4);
    assert.equal((await db.query('SELECT response_count FROM event_survey_assignment WHERE id=10')).rows[0].response_count, 1);
    assert.equal((await db.query('SELECT response_id FROM certificate_survey_entitlement')).rows[0].response_id, 1);
    assert.equal((await db.query('SELECT count(*)::int n FROM survey_answer WHERE tenant_id=2')).rows[0].n, 1);
    await db.query('ROLLBACK');
    assert.equal((await db.query('SELECT count(*)::int n FROM survey_answer')).rows[0].n, 3);
    assert.equal((await db.query('SELECT response_count FROM event_survey_assignment WHERE id=10')).rows[0].response_count, 2);
    await db.query('DELETE FROM form_submission WHERE tenant_id=1');
    assert.equal((await db.query('SELECT count(*)::int n FROM survey_answer WHERE tenant_id=1')).rows[0].n, 0);
    assert.equal((await db.query('SELECT response_count FROM event_survey_assignment WHERE id=10')).rows[0].response_count, 0);
    assert.deepEqual((await db.query('SELECT first_response_at,last_response_at FROM event_survey_assignment WHERE id=10')).rows[0], { first_response_at: null, last_response_at: null });
    await db.query('RESET ROLE');
    for (const role of ['anon','authenticated']) {
      await db.query(`SET ROLE ${role}`);
      await assert.rejects(db.query('DELETE FROM form_submission'), /permission denied/);
      await db.query('RESET ROLE');
    }
  } finally {
    if (db) await db.end();
    if (started) spawnSync('pg_ctl', ['-D', h.data, '-m', 'immediate', '-w', 'stop']);
    await h.cleanup();
  }
});
