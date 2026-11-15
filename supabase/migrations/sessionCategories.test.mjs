import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { createLocalPostgresHarness } from '../../scripts/test-support/local-postgres-harness.mjs';

test('session UUID array migration validates every DB writer and preserves legacy/partial updates', { timeout: 45000 }, async () => {
  const h = await createLocalPostgresHarness('session-categories-');
  const run = (command, args, input, fail = false) => {
    const r = spawnSync(command, args, { input, encoding: 'utf8' });
    if (fail) assert.notEqual(r.status, 0, 'Expected invalid assignment to fail');
    else assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  const sql = (input, fail) => run('psql', ['-h', h.socket, '-p', String(h.port), '-U', 'postgres', '-d', 'postgres', '-X', '-v', 'ON_ERROR_STOP=1', '-At'], input, fail);
  const a = '00000000-0000-0000-0000-000000000001';
  const b = '00000000-0000-0000-0000-000000000002';
  let started = false;
  try {
    run('initdb', ['-D', h.data, '-A', 'trust', '-U', 'postgres']);
    run('pg_ctl', ['-D', h.data, '-l', path.join(h.root, 'postgres.log'), '-o', `-F -k ${h.socket} -c listen_addresses= -p ${h.port}`, '-w', 'start']);
    started = true;
    sql(`CREATE TABLE resource_category(id uuid PRIMARY KEY, tenant_id text, is_active boolean);
      CREATE TABLE complex_event_session(id int PRIMARY KEY, tenant_id text, title text);
      INSERT INTO complex_event_session VALUES (1, 'a', 'Legacy');
      INSERT INTO resource_category VALUES ('${a}', 'a', true), ('${b}', 'b', true);`);
    const migration = readFileSync(new URL('./202701250001_session_categories.sql', import.meta.url), 'utf8');
    sql(migration); sql(migration);
    assert.equal(sql('SELECT cardinality(category_ids) FROM complex_event_session'), '0');
    sql(`UPDATE complex_event_session SET category_ids=ARRAY['${a}','${a}']::uuid[] WHERE id=1`);
    assert.equal(sql('SELECT cardinality(category_ids) FROM complex_event_session'), '1');
    sql("UPDATE complex_event_session SET title='Edited' WHERE id=1");
    assert.equal(sql('SELECT cardinality(category_ids) FROM complex_event_session'), '1');
    sql(`UPDATE complex_event_session SET category_ids=ARRAY['${b}']::uuid[] WHERE id=1`, true);
    sql("UPDATE complex_event_session SET category_ids=NULL WHERE id=1", true);
    sql("UPDATE complex_event_session SET category_ids=ARRAY[NULL]::uuid[] WHERE id=1", true);
    sql("UPDATE complex_event_session SET tenant_id='b' WHERE id=1", true);
    sql(`UPDATE resource_category SET is_active=false WHERE id='${a}'`);
    sql(`UPDATE complex_event_session SET category_ids=ARRAY['${a}']::uuid[] WHERE id=1`);
    sql(`INSERT INTO complex_event_session VALUES(2,'a','New',ARRAY['${a}']::uuid[])`, true);
    sql(`DELETE FROM resource_category WHERE id='${a}'`);
    sql(`UPDATE complex_event_session SET category_ids=ARRAY['${a}']::uuid[] WHERE id=1`);
    sql("UPDATE complex_event_session SET category_ids='{}' WHERE id=1");
    assert.equal(sql('SELECT cardinality(category_ids) FROM complex_event_session'), '0');
    sql(`UPDATE complex_event_session SET category_ids=ARRAY['${a}']::uuid[] WHERE id=1`, true);
  } finally {
    if (started) run('pg_ctl', ['-D', h.data, '-m', 'immediate', '-w', 'stop']);
    await h.cleanup();
  }
});
