import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import pg from 'pg';
import { createLocalPostgresHarness } from '../../scripts/test-support/local-postgres-harness.mjs';

test('preparation completion migration captures only new transitions, never backfills history, and preserves timestamps', { timeout: 120000 }, async () => {
  const h = await createLocalPostgresHarness('campaign-preparation-completion-');
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
      CREATE TABLE campaign_preparation (
        id integer PRIMARY KEY, phase text, updated_at timestamptz,
        last_error text, checkpoint integer DEFAULT 0
      );
      INSERT INTO campaign_preparation (id,phase,updated_at) VALUES
        (1,'complete','2020-01-01'), (2,'materializing','2020-01-02'),
        (3,'failed','2020-01-03');
    `);
    const migration = readFileSync('migrations/20261021_campaign_preparation_completion_time.sql', 'utf8');
    await db.query(migration);
    const load = async id => (await db.query('SELECT *, completed_at::text AS completed_at FROM campaign_preparation WHERE id=$1', [id])).rows[0];
    assert.equal((await db.query('SELECT count(*) FROM campaign_preparation WHERE completed_at IS NOT NULL')).rows[0].count, '0');
    await db.query("UPDATE campaign_preparation SET updated_at=now(), last_error='historical checkpoint' WHERE id=1");
    assert.equal((await load(1)).completed_at, null, 'historical completed rows must not infer completion from later updates');
    await db.query("UPDATE campaign_preparation SET completed_at='2001-01-01' WHERE id=1");
    assert.equal((await load(1)).completed_at, null, 'historical null cannot be backfilled by an ordinary update');
    await db.query("INSERT INTO campaign_preparation (id,phase,updated_at) VALUES (4,'materializing',now())");
    await db.query("UPDATE campaign_preparation SET updated_at=now(), checkpoint=1 WHERE id=4");
    assert.equal((await load(4)).completed_at, null);

    const before = (await db.query('SELECT clock_timestamp()::text AS at')).rows[0].at;
    await db.query("UPDATE campaign_preparation SET phase='complete', completed_at='2001-01-01' WHERE id=4");
    const completed = (await load(4)).completed_at;
    const after = (await db.query('SELECT clock_timestamp()::text AS at')).rows[0].at;
    assert.ok(completed, 'new transition must capture completion');
    assert.ok(Date.parse(completed) >= Date.parse(before));
    assert.ok(Date.parse(completed) <= Date.parse(after));
    assert.notEqual(completed.slice(0, 4), '2001', 'caller cannot forge transition timestamp');

    // Compare PostgreSQL text to preserve microseconds, not JS Date precision.
    for (const update of [
      "updated_at=now(), checkpoint=checkpoint+1, last_error='later checkpoint'",
      "completed_at=NULL",
      "completed_at='2002-01-01'",
      "phase='complete'",
      "phase='failed'",
    ]) {
      await db.query(`UPDATE campaign_preparation SET ${update} WHERE id=4`);
      assert.equal((await load(4)).completed_at, completed, `timestamp changed on ${update}`);
    }
    await db.query("UPDATE campaign_preparation SET updated_at=now() WHERE id=2");
    assert.equal((await load(2)).completed_at, null, 'ongoing preparation must remain unfinished');
    await db.query(migration);
    assert.equal((await load(1)).completed_at, null, 'rerun must not backfill history');
    assert.equal((await load(4)).completed_at, completed, 'rerun must preserve recorded completion');
    await db.query("UPDATE campaign_preparation SET checkpoint=checkpoint+1 WHERE id=4");
    assert.equal((await load(4)).completed_at, completed, 'later writes after rerun remain immutable');
  } finally {
    if (db) await db.end();
    if (started) spawnSync('pg_ctl', ['-D', h.data, '-m', 'immediate', '-w', 'stop']);
    await h.cleanup();
  }
});
