import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import pg from 'pg';
import { createLocalPostgresHarness } from '../../scripts/test-support/local-postgres-harness.mjs';

test('delivery migration restricts access, preserves provenance and serializes unresolved sends', { timeout: 120000 }, async () => {
  const h = await createLocalPostgresHarness('registrant-survey-');
  const run = (name, args) => { const r = spawnSync(name, args, { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
  let db, started = false;
  try {
    run('initdb', ['-D', h.data, '-A', 'trust', '-U', 'postgres']);
    run('pg_ctl', ['-D', h.data, '-l', path.join(h.root, 'postgres.log'), '-o', `-F -k ${h.socket} -c listen_addresses= -p ${h.port}`, '-w', 'start']); started = true;
    db = new pg.Client({ host: h.socket, port: h.port, user: 'postgres', database: 'postgres' }); await db.connect();
    await db.query(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE TABLE tenant(id uuid PRIMARY KEY);
      CREATE TABLE event_survey_assignment(id uuid PRIMARY KEY);
      INSERT INTO tenant VALUES('11111111-1111-4111-8111-111111111111');
      INSERT INTO event_survey_assignment VALUES('22222222-2222-4222-8222-222222222222');`);
    await db.query(readFileSync('supabase/migrations/202612310050_registrant_survey_delivery.sql', 'utf8'));
    for (const role of ['anon', 'authenticated']) {
      await db.query(`SET ROLE ${role}`);
      await assert.rejects(db.query('SELECT * FROM registrant_survey_delivery'), { code: '42501' });
      await db.query('RESET ROLE');
    }
    await db.query('SET ROLE service_role');
    const insert = id => db.query(`INSERT INTO registrant_survey_delivery(id,tenant_id,booking_source,booking_id,assignment_id,recipient,actor,fingerprint)
      VALUES($1,'11111111-1111-4111-8111-111111111111','standard','33333333-3333-4333-8333-333333333333',
      '22222222-2222-4222-8222-222222222222','guest@example.org','admin','fingerprint')`, [id]);
    await insert('44444444-4444-4444-8444-444444444444');
    await assert.rejects(insert('55555555-5555-4555-8555-555555555555'), { code: '23505' });
    await assert.rejects(db.query("UPDATE registrant_survey_delivery SET recipient='different@example.org'"), { code: '42501' });
    await assert.rejects(db.query('DELETE FROM registrant_survey_delivery'), { code: '42501' });
    await db.query("UPDATE registrant_survey_delivery SET status='unknown'");
    await assert.rejects(insert('55555555-5555-4555-8555-555555555555'), { code: '23505' });
    await db.query("UPDATE registrant_survey_delivery SET status='accepted',provider_message_id='accepted-message',updated_at=now()");
    await insert('55555555-5555-4555-8555-555555555555');
    assert.equal((await db.query('SELECT count(*) FROM registrant_survey_delivery')).rows[0].count, '2');
  } finally {
    await db?.end();
    if (started) spawnSync('pg_ctl', ['-D', h.data, '-m', 'immediate', '-w', 'stop'], { encoding: 'utf8' });
    await h.cleanup();
  }
});
