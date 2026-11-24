import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';

test('rollout control serializes writers, blocks unfinished operations and protects privileges', async t => {
  const root = await mkdtemp(join(tmpdir(), 'speaker-rollout-'));
  execFileSync('initdb', ['-D',join(root,'data'),'-A','trust','-U','postgres'], { stdio:'ignore' });
  execFileSync('pg_ctl', ['-D',join(root,'data'),'-o',`-F -k ${root} -c listen_addresses=''`,'-w','start'], { stdio:'ignore' });
  const clients = [];
  t.after(async () => {
    await Promise.allSettled(clients.map(c => c.end()));
    execFileSync('pg_ctl', ['-D',join(root,'data'),'-m','immediate','stop'], { stdio:'ignore' });
    await rm(root, { recursive:true, force:true });
  });
  async function connect() {
    const c = new pg.Client({ host:root, user:'postgres', database:'postgres' });
    await c.connect(); clients.push(c); return c;
  }
  const c = await connect(), writer = await connect();
  await c.query(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE TABLE event(id int primary key,title text,bookings int);
    CREATE TABLE complex_event(id int primary key,title text);
    CREATE TABLE complex_event_session(id int primary key);
    CREATE TABLE event_agenda_item(id int primary key);
    CREATE TABLE speaker(id int primary key);
    CREATE TABLE speaker_award_grant(id int primary key);
    CREATE TABLE speaker_recognition(id int primary key);
    INSERT INTO event VALUES(1,'Original',0);
    INSERT INTO speaker_award_grant VALUES(1);`);
  await c.query(await readFile(new URL('./202701230001_training_speaker_rollout_control.sql', import.meta.url), 'utf8'));
  await c.query('SET ROLE service_role');
  const op = (await c.query(`SELECT begin_speaker_rollout_operation('fixture','fixture','fixture') id`)).rows[0].id;
  await assert.rejects(c.query(`SELECT set_speaker_rollout_phase('draining',0,'not allowed')`), { code:'42501' });
  await assert.rejects(c.query(`UPDATE speaker_rollout_operation SET finished_at=now()`), { code:'42501' });
  await c.query('RESET ROLE');
  await c.query(`SELECT set_speaker_rollout_phase('draining',0,'fixture caller coverage verified')`);
  await assert.rejects(c.query(`SELECT begin_speaker_rollout_operation('fixture','fixture','fixture')`), { code:'PT503' });
  await assert.rejects(c.query(`SELECT set_speaker_rollout_phase('paused',1,'fixture drain checked')`), { code:'PT409' });
  // Age does not close abandoned operations.
  await c.query(`UPDATE speaker_rollout_operation SET started_at=now()-interval '1 year'`);
  await assert.rejects(c.query(`SELECT set_speaker_rollout_phase('paused',1,'fixture drain checked')`), { code:'PT409' });
  await c.query(`SELECT finish_speaker_rollout_operation($1,false)`, [op]);
  await writer.query('BEGIN');
  await writer.query(`UPDATE event SET title='Finished before pause' WHERE id=1`);
  let paused = false;
  const pause = c.query(`SELECT set_speaker_rollout_phase('paused',1,'fixture external work verified drained')`).then(() => { paused = true; });
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(paused, false);
  await writer.query('COMMIT'); await pause;
  await assert.rejects(c.query(`UPDATE event SET title='Blocked' WHERE id=1`), { code:'PT503' });
  await assert.rejects(c.query(`INSERT INTO event_agenda_item VALUES(1)`), { code:'PT503' });
  await assert.rejects(c.query(`DELETE FROM speaker_award_grant`), { code:'PT503' });
  await c.query(`UPDATE event SET bookings=1 WHERE id=1`);
  assert.equal((await c.query('SELECT count(*)::int n FROM speaker_award_grant')).rows[0].n, 1);
  for (const role of ['anon','authenticated']) {
    await c.query(`SET ROLE ${role}`);
    await assert.rejects(c.query('SELECT * FROM speaker_rollout_control'), { code:'42501' });
    await assert.rejects(c.query(`SELECT begin_speaker_rollout_operation('fixture','fixture','fixture')`), { code:'42501' });
    await c.query('RESET ROLE');
  }
  await assert.rejects(c.query(`SELECT set_speaker_rollout_phase('open',1,'stale operator request')`), { code:'PT409' });
  await c.query(`SELECT set_speaker_rollout_phase('open',2,'fixture verification completed')`);
  await c.query(`UPDATE event SET title='Resumed' WHERE id=1`);
});
