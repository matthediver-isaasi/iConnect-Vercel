import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { createLocalPostgresHarness } from '../../scripts/test-support/local-postgres-harness.mjs';

test('event display-mode migration is idempotent and enforces defaults and values', { timeout: 45000 }, async () => {
  const h = await createLocalPostgresHarness('event-display-');
  const run = (cmd, args, input, fail = false) => {
    const result = spawnSync(cmd, args, { input, encoding: 'utf8' });
    if (fail) assert.notEqual(result.status, 0, 'invalid display mode must fail');
    else assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout;
  };
  const sql = (input, fail = false) => run(
    'psql',
    ['-h', h.socket, '-p', String(h.port), '-U', 'postgres', '-d', 'postgres', '-X', '-v', 'ON_ERROR_STOP=1', '-At'],
    input,
    fail,
  );
  let started = false;
  try {
    run('initdb', ['-D', h.data, '-A', 'trust', '-U', 'postgres']);
    run('pg_ctl', ['-D', h.data, '-l', path.join(h.root, 'postgres.log'), '-o', `-F -k ${h.socket} -c listen_addresses= -p ${h.port}`, '-w', 'start']);
    started = true;
    sql('CREATE TABLE event(id text); CREATE TABLE complex_event(id text); INSERT INTO event VALUES (\'existing\');');
    const migration = readFileSync(new URL('./202609200001_event_speaker_sponsor_display_modes.sql', import.meta.url), 'utf8');
    sql(migration);
    sql(migration);
    assert.equal(sql('SELECT speaker_display_mode || \'/\' || sponsor_display_mode FROM event;').trim(), 'expanded/expanded');
    sql("INSERT INTO complex_event(id, speaker_display_mode, sponsor_display_mode) VALUES ('ok', 'hidden', 'collapsed');");
    assert.equal(sql("SELECT speaker_display_mode || '/' || sponsor_display_mode FROM complex_event WHERE id='ok';").trim(), 'hidden/collapsed');
    sql("UPDATE event SET speaker_display_mode='visible';", true);
    sql("INSERT INTO complex_event(id, sponsor_display_mode) VALUES ('bad', NULL);", true);
  } finally {
    if (started) run('pg_ctl', ['-D', h.data, '-m', 'immediate', '-w', 'stop']);
    await h.cleanup();
  }
});