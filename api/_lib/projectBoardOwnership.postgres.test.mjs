import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import pg from 'pg';
import { createLocalPostgresHarness } from '../../scripts/test-support/local-postgres-harness.mjs';

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const source = readFileSync(new URL('../../supabase/migrations/202702060001_project_board_ownership.sql', import.meta.url), 'utf8');

test('group creation assigns ownership and cleans up failed legacy owner insertion', () => {
  const group = readFileSync(new URL('../member-group-projects/boards.js', import.meta.url), 'utf8');
  const automatic = readFileSync(new URL('./memberGroupProjectsAccess.js', import.meta.url), 'utf8');
  assert.match(group, /role: 'owner'/);
  assert.match(group, /user_role: 'owner'/);
  assert.doesNotMatch(group, /role: 'admin'/);
  assert.match(automatic, /role: 'owner'/);
  assert.match(automatic, /if \(ownerError\)[\s\S]*?delete\(\)\.eq\('id', board\.id\)[\s\S]*?throw new Error/);
  const page = readFileSync(new URL('../../client/src/pages/ProjectBoard.jsx', import.meta.url), 'utf8');
  assert.match(page, /const ownerCount = members\.filter\(member => member\.role === 'owner'\)\.length/);
  assert.match(page, /disabled=\{member\.role === 'owner' && \(userRole !== 'owner' \|\| ownerCount === 1\)\}/);
  assert.match(page, /Assign another owner before changing or removing the last board owner/);
});

test('ownership is atomic, race-safe, scoped and compatible with legacy/Sales creation', { timeout: 45000 }, async () => {
  const h = await createLocalPostgresHarness('board-ownership-');
  const run = (command, args) => {
    const r = spawnSync(command, args, { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  };
  let started = false, pool, a, b;
  try {
    run('initdb', ['-D', h.data, '-A', 'trust', '-U', 'postgres', '--no-instructions']);
    run('pg_ctl', ['-D', h.data, '-l', `${h.root}/postgres.log`, '-o', `-F -k ${h.socket} -c listen_addresses= -p ${h.port}`, '-w', 'start']);
    started = true;
    pool = new pg.Pool({ host: h.socket, port: h.port, user: 'postgres', database: 'postgres' });
    const q = (text, params = []) => pool.query(text, params);
    await q(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE TABLE project_board(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,
        created_by uuid NOT NULL,name text NOT NULL);
      CREATE TABLE project_board_member(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        board_id uuid NOT NULL REFERENCES project_board ON DELETE CASCADE,identity_id uuid NOT NULL,
        role varchar DEFAULT 'member',added_by uuid,added_at timestamp DEFAULT now(),UNIQUE(board_id,identity_id));
      CREATE TABLE member(tenant_id uuid,identity_id text);
    `);
    await q('INSERT INTO project_board VALUES($1,$2,$3,$4)', [id(9), id(1), id(10), 'Legacy ownerless']);
    await q('INSERT INTO project_board_member(board_id,identity_id,role) VALUES($1,$2,$3)', [id(9), id(10), 'admin']);
    await q(source);
    await q(source);
    await q('GRANT USAGE ON SCHEMA public TO service_role; GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role');
    assert.equal((await q('SELECT role FROM project_board_member WHERE board_id=$1', [id(9)])).rows[0].role, 'admin');
    const create = async n => q('INSERT INTO project_board VALUES($1,$2,$3,$4)', [id(n), id(1), id(10), `Board ${n}`]);
    const count = async n => Number((await q("SELECT count(*) FROM project_board_member WHERE board_id=$1 AND role='owner'", [id(n)])).rows[0].count);
    const mutate = (board, actor, target, action, role = null, connection = pool, tenant = 1) =>
      connection.query('SELECT change_project_board_member($1,$2,$3,$4,$5,$6)', [id(tenant), id(board), id(actor), id(target), action, role]);
    for (const person of [10, 11, 12]) await q('INSERT INTO member VALUES($1,$2)', [id(1), id(person)]);
    await create(20);
    assert.equal(await count(20), 1);
    // Old ordinary/group creation and sharing upserts cannot downgrade owner.
    for (const role of ['owner', 'admin']) {
      await q(`INSERT INTO project_board_member(board_id,identity_id,role,added_by) VALUES($1,$2,$3,$2)
        ON CONFLICT(board_id,identity_id) DO UPDATE SET role=excluded.role`, [id(20), id(10), role]);
      assert.equal(await count(20), 1);
    }
    for (const operation of [
      () => mutate(20, 10, 10, 'role', 'admin'),
      () => mutate(20, 10, 10, 'remove'),
      () => q('DELETE FROM project_board_member WHERE board_id=$1', [id(20)]),
      () => q('UPDATE project_board_member SET role=NULL WHERE board_id=$1', [id(20)]),
    ]) await assert.rejects(operation, { code: 'PT409' });
    await mutate(20, 10, 11, 'add', 'admin');
    await assert.rejects(() => mutate(20, 11, 12, 'add', 'owner'), { code: '42501' });
    await assert.rejects(() => mutate(20, 11, 11, 'role', 'owner'), { code: '42501' });
    await assert.rejects(() => mutate(20, 11, 10, 'remove'), { code: '42501' });
    await assert.rejects(() => mutate(20, 10, 12, 'add', 'owner', pool, 2), { code: 'P0002' });
    await assert.rejects(() => mutate(20, 10, 99, 'add', 'owner'), { code: 'P0002' });
    await mutate(20, 10, 11, 'role', 'owner');
    await mutate(20, 10, 10, 'role', 'admin');
    assert.equal(await count(20), 1, 'handoff is allowed once another owner is assigned');
    await assert.rejects(() => mutate(9, 10, 10, 'role', 'owner'), { code: '42501' });
    await create(21);
    await assert.rejects(() => q('UPDATE project_board_member SET board_id=$1 WHERE board_id=$2 AND identity_id=$3',
      [id(21), id(20), id(11)]), { code: 'PT409' });
    a = await pool.connect(); b = await pool.connect();
    for (const mode of ['raw', 'rpc']) {
      const board = mode === 'raw' ? 22 : 23;
      await create(board); await mutate(board, 10, 11, 'add', 'owner');
      await a.query('BEGIN');
      await a.query("UPDATE project_board_member SET role='admin' WHERE board_id=$1 AND identity_id=$2", [id(board), id(10)]);
      const pending = (mode === 'raw'
        ? b.query("UPDATE project_board_member SET role='admin' WHERE board_id=$1 AND identity_id=$2", [id(board), id(11)])
        : mutate(board, 11, 11, 'role', 'admin', b)).then(result => ({ result }), error => ({ error }));
      // Confirm serialization, rather than relying on an arbitrary race delay.
      let blocked = false;
      for (let attempt = 0; attempt < 80; attempt++) {
        blocked = (await q('SELECT $1::integer=ANY(pg_blocking_pids($2::integer)) AS blocked', [a.processID, b.processID])).rows[0].blocked;
        if (blocked) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert(blocked, `${mode} writers serialize on their board`);
      await a.query('COMMIT');
      assert.equal((await pending).error?.code, 'PT409');
      assert.equal(await count(board), 1);
    }
    // Cached API role checks cannot survive a concurrent demotion.
    await create(24); await mutate(24, 10, 11, 'add', 'admin');
    await a.query('BEGIN');
    await a.query("UPDATE project_board_member SET role='viewer' WHERE board_id=$1 AND identity_id=$2", [id(24), id(11)]);
    const staleActor = mutate(24, 11, 12, 'add', 'member', b).then(result => ({ result }), error => ({ error }));
    await a.query('COMMIT');
    assert.equal((await staleActor).error?.code, '42501');
    await q(`CREATE FUNCTION fixture_reject_owner() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.identity_id='${id(99)}' THEN RAISE EXCEPTION 'fixture owner failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER fixture_reject_owner BEFORE INSERT ON project_board_member FOR EACH ROW EXECUTE FUNCTION fixture_reject_owner();`);
    await assert.rejects(() => q('INSERT INTO project_board VALUES($1,$2,$3,$4)', [id(25), id(1), id(99), 'Failure']));
    assert.equal((await q('SELECT count(*) FROM project_board WHERE id=$1', [id(25)])).rows[0].count, '0');
    await q('DELETE FROM project_board WHERE id=$1', [id(21)]);
    assert.equal((await q('SELECT count(*) FROM project_board_member WHERE board_id=$1', [id(21)])).rows[0].count, '0');
    for (const role of ['anon', 'authenticated', 'service_role']) {
      assert.equal((await q("SELECT has_function_privilege($1,'change_project_board_member(uuid,uuid,uuid,uuid,text,text)','EXECUTE') AS allowed",
        [role])).rows[0].allowed, role === 'service_role');
    }
    await a.query('SET ROLE service_role');
    await mutate(24, 10, 12, 'add', 'member', a);
    await a.query('RESET ROLE');
  } finally {
    if (a) { await a.query('ROLLBACK').catch(() => {}); a.release(); }
    if (b) { await b.query('ROLLBACK').catch(() => {}); b.release(); }
    await pool?.end();
    if (started) run('pg_ctl', ['-D', h.data, '-m', 'immediate', '-w', 'stop']);
    await h.cleanup();
  }
});
