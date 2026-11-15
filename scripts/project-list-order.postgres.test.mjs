import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import pg from 'pg';
import { createLocalPostgresHarness } from './test-support/local-postgres-harness.mjs';

test('list reorder validates whole active set, permissions and rolls back database failures', async () => {
  const h = await createLocalPostgresHarness('list-order-');
  const run = (cmd, args) => {
    const result = spawnSync(cmd, args, { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  let db, started = false;
  const id = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
  try {
    run('initdb', ['-D', h.data, '-A', 'trust', '-U', 'postgres']);
    run('pg_ctl', ['-D', h.data, '-l', path.join(h.root, 'log'), '-o', `-F -k ${h.socket} -c listen_addresses= -p ${h.port}`, '-w', 'start']);
    started = true;
    db = new pg.Client({ host: h.socket, port: h.port, user: 'postgres', database: 'postgres' });
    await db.connect();
    await db.query(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE TABLE project_board(id uuid primary key, tenant_id uuid);
      CREATE TABLE project_board_member(board_id uuid, identity_id uuid, role text);
      CREATE TABLE project_list(id uuid primary key, board_id uuid, position int, color text,
        is_archived boolean default false, updated_at timestamp);
      INSERT INTO project_board VALUES ('${id(1)}','${id(2)}'),('${id(9)}','${id(2)}');
      INSERT INTO project_board_member VALUES ('${id(1)}','${id(3)}','member'),('${id(1)}','${id(4)}','viewer');
      INSERT INTO project_list(id,board_id,position,is_archived) VALUES
        ('${id(5)}','${id(1)}',0,false),('${id(6)}','${id(1)}',1,false),
        ('${id(7)}','${id(1)}',2,true),('${id(8)}','${id(9)}',0,false);`);
    await db.query(readFileSync('scripts/migrations/project-list-order.sql', 'utf8'));
    const reorder = (ids, actor = id(3), tenant = id(2)) =>
      db.query('SELECT * FROM reorder_project_lists($1,$2,$3,$4)', [id(1), tenant, actor, ids]);
    const order = async () => (await db.query('SELECT id FROM project_list WHERE board_id=$1 AND NOT is_archived ORDER BY position,id', [id(1)])).rows.map(row => row.id);
    await db.query('SET ROLE service_role');
    assert.deepEqual((await reorder([id(6), id(5)])).rows.map(row => row.id), [id(6), id(5)]);
    for (const ids of [[], [id(5)], [id(5), id(5)], [id(5), id(8)], [id(5), id(7)], [id(5), null]]) {
      await assert.rejects(reorder(ids), error => error.code === 'PT409');
    }
    await assert.rejects(reorder([id(5), id(6)], id(4)), error => error.code === '42501');
    await assert.rejects(reorder([id(5), id(6)], id(3), id(99)), error => error.code === '42501');
    await db.query('RESET ROLE');
    assert.deepEqual(await order(), [id(6), id(5)]);
    await db.query(`CREATE FUNCTION fail_list_write() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.id='${id(6)}' THEN RAISE EXCEPTION 'injected write failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER list_failure BEFORE UPDATE ON project_list FOR EACH ROW EXECUTE FUNCTION fail_list_write();`);
    await assert.rejects(reorder([id(5), id(6)]), /injected write failure/);
    assert.deepEqual(await order(), [id(6), id(5)]);
    await db.query('SET ROLE authenticated');
    await assert.rejects(reorder([id(5), id(6)]), /permission denied/);
  } finally {
    await db?.end();
    if (started) spawnSync('pg_ctl', ['-D', h.data, '-m', 'immediate', 'stop'], { stdio: 'ignore' });
    await h.cleanup();
  }
});
