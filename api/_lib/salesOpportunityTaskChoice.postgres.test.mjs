import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootPath = fileURLToPath(new URL('../../', import.meta.url));
const u = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const base = `
 CREATE EXTENSION IF NOT EXISTS pgcrypto;
 CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
 CREATE SCHEMA auth;
 CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$SELECT 'service_role'::text$$;
 GRANT USAGE ON SCHEMA auth TO service_role;
 CREATE TABLE tenant(id uuid PRIMARY KEY);
 CREATE TABLE organization(id uuid PRIMARY KEY,tenant_id uuid NOT NULL,name text);
 CREATE TABLE tenant_identity(id varchar PRIMARY KEY,first_name text,last_name text,email text);
 CREATE TABLE tenant_membership(id varchar PRIMARY KEY,identity_id varchar,tenant_id uuid,status varchar,role varchar,membership_type varchar);
 CREATE TABLE member(id uuid PRIMARY KEY,tenant_id uuid NOT NULL,organization_id uuid,identity_id text,first_name text,last_name text,email text);
 CREATE TABLE tenant_user(id uuid PRIMARY KEY,tenant_id uuid NOT NULL,identity_id varchar,first_name text,last_name text,email text);
 CREATE TABLE event(id uuid PRIMARY KEY,tenant_id uuid NOT NULL);
 CREATE TABLE sales_settings(tenant_id uuid PRIMARY KEY,quote_task_list_name text NOT NULL DEFAULT 'Quote tasks');
`;

test('Opportunity task choice: atomic create/link, rollback, lock and legacy exception', { timeout: 120000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sales-task-choice-'));
  const data = path.join(root, 'data'), socket = path.join(root, 'socket');
  await mkdir(socket);
  const args = ['-h', socket, '-p', '55461', '-U', 'postgres', '-d', 'postgres', '--no-psqlrc', '-v', 'ON_ERROR_STOP=1', '-q', '-t', '-A'];
  const run = (command, cmdArgs, input = '') => {
    const r = spawnSync(command, cmdArgs, { input, encoding: 'utf8', maxBuffer: 2e6 });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    return r.stdout.trim();
  };
  const sql = text => run('psql', args, text);
  const apply = file => run('psql', [...args, '-f', path.join(rootPath, file)]);
  const rejects = (statement, code) => sql(`DO $test$ BEGIN
    BEGIN ${statement} RAISE EXCEPTION 'expected rejection'; EXCEPTION WHEN SQLSTATE '${code}' THEN NULL; END;
    END $test$;`);
  const row = (name, extra = {}) => JSON.stringify({ organization_id: u(5), stage_id: u(7), owner_kind: 'member',
    owner_id: u(10), name, priority: 'high', value_minor: 1200, ...extra }).replace(/'/g, "''");
  const create = (action, name, board = null, actor = 10, identity = 20) =>
    `public.create_sales_opportunity_with_project('${u(1)}','member','${u(actor)}','${u(identity)}','${row(name)}'::jsonb,'${action}',${board ? `'${typeof board === 'number' ? u(board) : board}'` : 'NULL'})`;
  const change = (op, action, version, board = null) =>
    `public.change_sales_project('${u(1)}','${op}','member','${u(10)}',false,'${u(20)}',${version},'${action}',${action === 'mode' ? "'standard'" : 'NULL'},${board ? `'${u(board)}'` : 'NULL'})`;
  const count = (table, where = 'true') => sql(`SELECT count(*) FROM ${table} WHERE ${where}`);
  let started = false;
  try {
    run('initdb', ['-D', data, '-A', 'trust', '-U', 'postgres', '--no-instructions']);
    run('pg_ctl', ['-D', data, '-l', path.join(root, 'postgres.log'), '-o', `-F -k ${socket} -c listen_addresses= -p 55461`, '-w', 'start']);
    started = true;
    sql(base);
    apply('scripts/migrations/add-project-management.sql');
    apply('supabase/migrations/20260908_opportunity_pipeline.sql');
    apply('supabase/migrations/202701240001_opportunity_owner_identity.sql');
    apply('supabase/migrations/202701240002_opportunity_identity_type_compatibility.sql');
    apply('supabase/migrations/202610090001_sales_project_tasks.sql');
    sql(`
      INSERT INTO tenant VALUES('${u(1)}'),('${u(2)}');
      INSERT INTO organization VALUES('${u(5)}','${u(1)}','Customer');
      INSERT INTO tenant_identity VALUES('${u(20)}','Alex','Owner','alex@example.test'),('${u(21)}','Pat','Viewer','pat@example.test');
      INSERT INTO member VALUES('${u(10)}','${u(1)}','${u(5)}','${u(20)}','Alex','Owner','alex@example.test'),
        ('${u(11)}','${u(1)}','${u(5)}','${u(21)}','Pat','Viewer','pat@example.test');
      INSERT INTO opportunity_stage(id,tenant_id,name,position) VALUES('${u(7)}','${u(1)}','Open',0);
      INSERT INTO opportunity(id,tenant_id,organization_id,stage_id,owner_kind,owner_id,name,created_by_kind,created_by_id,task_mode)
      VALUES('${u(30)}','${u(1)}','${u(5)}','${u(7)}','member','${u(10)}','Legacy standard','member','${u(10)}','standard');
    `);
    // Predecessor allows a mode switch; create a legacy "project mode, no board" opportunity with it.
    sql(`INSERT INTO opportunity(id,tenant_id,organization_id,stage_id,owner_kind,owner_id,name,created_by_kind,created_by_id)
      VALUES('${u(31)}','${u(1)}','${u(5)}','${u(7)}','member','${u(10)}','Legacy unlinked','member','${u(10)}');
      SELECT ${change(u(31), 'mode', 1).replace("'standard'", "'project'")};`);
    // Legacy linked opportunity created through the predecessor function.
    sql(`INSERT INTO opportunity(id,tenant_id,organization_id,stage_id,owner_kind,owner_id,name,created_by_kind,created_by_id)
      VALUES('${u(32)}','${u(1)}','${u(5)}','${u(7)}','member','${u(10)}','Legacy linked','member','${u(10)}');
      SELECT ${change(u(32), 'create', 1)};`);

    apply('supabase/migrations/202702020001_sales_opportunity_task_choice.sql');
    apply('supabase/migrations/202702020001_sales_opportunity_task_choice.sql'); // replay-safe
    apply('supabase/migrations/202702030002_sales_project_unified_identity.sql');
    apply('supabase/migrations/202702030002_sales_project_unified_identity.sql');
    const migrationSql = await readFile(path.join(rootPath, 'supabase/migrations/202610120004_sales_automatic_quote_task_lists.sql'), 'utf8');
    const start = migrationSql.indexOf('CREATE FUNCTION public.sales_quote_task_destination');
    sql(migrationSql.slice(start, migrationSql.indexOf('END $$;', start) + 'END $$;'.length));
    sql(`GRANT USAGE ON SCHEMA public TO service_role,anon,authenticated;
      GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;`);

    for (const fn of ['create_sales_opportunity_with_project(uuid,text,uuid,uuid,jsonb,text,uuid)',
      'sales_project_attach_board(uuid,uuid,text,text,uuid,uuid,text,uuid)',
      'change_sales_project(uuid,uuid,text,uuid,boolean,uuid,integer,text,text,uuid)']) {
      assert.equal(sql(`SELECT has_function_privilege('anon','${fn}','execute')`), 'f', fn);
      assert.equal(sql(`SELECT has_function_privilege('authenticated','${fn}','execute')`), 'f', fn);
      assert.equal(sql(`SELECT has_function_privilege('service_role','${fn}','execute')`), 't', fn);
    }

    // 1. Create a new board immediately, as the actual service role.
    const created = JSON.parse(sql(`SET ROLE service_role; SELECT ${create('create', 'New deal')};`));
    assert.equal(created.task_mode, 'project');
    assert.equal(created.name, 'New deal');
    assert.equal(created.created_by_id, u(10));
    assert.equal(created.version, 1);
    const board = created.project_board_id;
    assert.equal(sql(`SELECT board_id FROM sales_opportunity_project WHERE opportunity_id='${created.id}'`), board);
    assert.equal(sql(`SELECT name||'|'||visibility||'|'||created_by FROM project_board WHERE id='${board}'`), `New deal|private|${u(20)}`);
    assert.equal(sql(`SELECT identity_id||'|'||role FROM project_board_member WHERE board_id='${board}'`), `${u(20)}|owner`);
    assert.equal(count('project_label', `board_id='${board}'`), '6');
    assert.equal(count('project_list', `board_id='${board}'`), '0', 'No invented lists or tasks');
    assert.equal(count('opportunity_activity', `opportunity_id='${created.id}' AND action IN ('opportunity.created','project.create')`), '2');

    // Quote acceptance routes to the board created with the opportunity.
    const destination = sql(`SET ROLE service_role; SELECT board_id||'|'||identity_id FROM sales_quote_task_destination('${u(1)}','${created.id}',NULL);`);
    assert.equal(destination, `${board}|${u(20)}`);
    assert.equal(sql(`SELECT name FROM project_list WHERE board_id='${board}'`), 'Quote tasks');

    // 2. Link an existing eligible board.
    sql(`INSERT INTO project_board(id,tenant_id,name,created_by) VALUES('${u(60)}','${u(1)}','Existing','${u(20)}'),
        ('${u(61)}','${u(1)}','Viewer only','${u(21)}'),('${u(62)}','${u(1)}','Archived','${u(20)}'),('${u(63)}','${u(2)}','Other tenant','${u(20)}');
      INSERT INTO project_board_member(board_id,identity_id,role) VALUES('${u(60)}','${u(20)}','admin'),
        ('${u(61)}','${u(21)}','owner'),('${u(61)}','${u(20)}','viewer'),('${u(62)}','${u(20)}','owner'),('${u(63)}','${u(20)}','owner');
      UPDATE project_board SET is_archived=true WHERE id='${u(62)}';`);
    const before = count('opportunity');
    const linked = JSON.parse(sql(`SELECT ${create('link', 'Linked deal', 60)};`));
    assert.equal(linked.project_board_id, u(60));
    assert.equal(linked.task_mode, 'project');
    assert.equal(Number(count('opportunity')), Number(before) + 1);

    // 3. Rollback: conflicts and ineligible boards leave no opportunity or board behind.
    const opportunities = count('opportunity'), boards = count('project_board'), links = count('sales_opportunity_project');
    rejects(`PERFORM ${create('link', 'Conflict', 60)};`, '23505');
    const legacyBoard = sql(`SELECT board_id FROM sales_opportunity_project WHERE opportunity_id='${u(32)}'`);
    rejects(`PERFORM ${create('link', 'Linked elsewhere', legacyBoard)};`, '23505');
    for (const ineligible of [61, 62, 63, 99]) rejects(`PERFORM ${create('link', 'Ineligible', ineligible)};`, '42501');
    rejects(`PERFORM ${create('create', 'Wrong identity', null, 10, 21)};`, '42501');
    rejects(`PERFORM ${create('standard', 'Invalid')};`, '22023');
    rejects(`PERFORM public.create_sales_opportunity_with_project('${u(1)}','member','${u(10)}','${u(20)}','${row('Bad stage', { stage_id: u(99) })}'::jsonb,'create',NULL);`, '23514');
    assert.equal(count('opportunity'), opportunities);
    assert.equal(count('project_board'), boards);
    assert.equal(count('sales_opportunity_project'), links);
    assert.equal(count('opportunity', `name IN ('Conflict','Ineligible','Wrong identity','Bad stage')`), '0');

    // Concurrent links of the same board: exactly one opportunity commits.
    sql(`INSERT INTO project_board(id,tenant_id,name,created_by) VALUES('${u(64)}','${u(1)}','Race','${u(20)}');
      INSERT INTO project_board_member(board_id,identity_id,role) VALUES('${u(64)}','${u(20)}','owner');`);
    const concurrent = name => new Promise(resolve => {
      const p = spawn('psql', args, { stdio: ['pipe', 'pipe', 'pipe'] });
      p.stdout.resume(); p.stderr.resume();
      p.on('exit', code => resolve(code));
      p.stdin.end(`SELECT ${create('link', name, 64)};`);
    });
    assert.deepEqual((await Promise.all([concurrent('Race A'), concurrent('Race B')])).sort(), [0, 3]);
    assert.equal(count('opportunity', `name IN ('Race A','Race B')`), '1');

    // 4. Lock: no mode switch, unlink, or relink after creation.
    for (const [op, action, version, boardId] of [
      [created.id, 'mode', 1], [created.id, 'unlink', 1], [created.id, 'create', 1], [created.id, 'link', 1, 60],
      [u(30), 'mode', 1], [u(30), 'create', 1], [u(30), 'link', 1, 64],
      [u(32), 'unlink', 2], [u(32), 'mode', 2], [u(32), 'create', 2],
    ]) rejects(`PERFORM ${change(op, action, version, boardId)};`, '55000');
    assert.equal(sql(`SELECT task_mode FROM opportunity WHERE id='${u(30)}'`), 'standard');
    assert.equal(count('sales_opportunity_project', `opportunity_id='${u(32)}'`), '1');
    rejects(`PERFORM ${change(u(31), 'mode', 2)};`, '55000');

    // 5. Legacy exception: project mode with no board may create or link exactly once.
    sql(`INSERT INTO project_board(id,tenant_id,name,created_by) VALUES('${u(65)}','${u(1)}','Legacy target','${u(20)}');
      INSERT INTO project_board_member(board_id,identity_id,role) VALUES('${u(65)}','${u(20)}','owner');`);
    assert.deepEqual(JSON.parse(sql(`SELECT ${change(u(31), 'link', 2, 65)};`)), { success: true });
    assert.equal(sql(`SELECT board_id FROM sales_opportunity_project WHERE opportunity_id='${u(31)}'`), u(65));
    assert.equal(sql(`SELECT task_mode||'|'||version FROM opportunity WHERE id='${u(31)}'`), 'project|3');
    rejects(`PERFORM ${change(u(31), 'unlink', 3)};`, '55000');
    rejects(`PERFORM ${change(u(31), 'create', 3)};`, '55000');

    // 6. Deleting a linked board (cascades the link) never reopens attachment,
    // for a new opportunity, a backfilled legacy link, or a used legacy exception.
    assert.equal(count('sales_opportunity_board_attachment', `opportunity_id IN ('${created.id}','${u(32)}','${u(31)}')`), '3');
    sql(`DELETE FROM project_board WHERE id IN ('${board}','${legacyBoard}','${u(65)}')`);
    assert.equal(count('sales_opportunity_project', `opportunity_id IN ('${created.id}','${u(32)}','${u(31)}')`), '0');
    for (const [op, version] of [[created.id, 1], [u(32), 2], [u(31), 3]]) {
      rejects(`PERFORM ${change(op, 'create', version)};`, '55000');
      rejects(`PERFORM ${change(op, 'link', version, 60)};`, '55000');
      rejects(`PERFORM public.sales_project_attach_board('${u(1)}','${op}','X','member','${u(10)}','${u(20)}','create',NULL);`, '23505');
    }
    assert.equal(count('sales_opportunity_project', `opportunity_id IN ('${created.id}','${u(32)}','${u(31)}')`), '0');
    // The attachment record is service-only.
    assert.equal(sql(`SELECT has_table_privilege('authenticated','sales_opportunity_board_attachment','select')`), 'f');
    // Unified staff have identity IDs but no legacy tenant_user rows.
    sql(`INSERT INTO tenant_identity(id,first_name) VALUES
      ('${u(90)}','Unified admin'),('${u(91)}','Other tenant'),('${u(92)}','Inactive'),
      ('${u(93)}','Portal only'),('${u(94)}','Membership owner'),('external-non-uuid','External key');
      INSERT INTO tenant_membership(id,identity_id,tenant_id,status,role,membership_type) VALUES
      ('90-member','${u(90)}','${u(1)}','active','member','team'),
      ('90-admin','${u(90)}','${u(1)}','active','admin','team'),
      ('91','${u(91)}','${u(2)}','active','admin','owner'),
      ('92','${u(92)}','${u(1)}','inactive','admin','owner'),
      ('93','${u(93)}','${u(1)}','active','member','member'),
      ('94','${u(94)}','${u(1)}','active','member','owner'),
      ('95','${u(95)}','${u(1)}','active','admin','owner');
      INSERT INTO tenant_user(id,tenant_id,identity_id) VALUES('${u(96)}','${u(1)}','${u(21)}');`);
    const identity = (kind, actor, tenant = 1) => sql(`SELECT public.sales_project_actor_identity('${u(tenant)}','${kind}','${u(actor)}')`);
    assert.equal(identity('tenant_user', 90), u(90), 'duplicates do not hide a staff membership');
    assert.equal(identity('tenant_user', 94), u(94));
    assert.equal(identity('tenant_user', 96), u(21), 'legacy staff identity mapping is unchanged');
    assert.equal(identity('member', 10), u(20), 'member masquerades use the member identity');
    for (const actor of [91, 92, 93, 95]) assert.equal(identity('tenant_user', actor), '', `deny identity ${actor}`);
    assert.equal(identity('tenant_user', 90, 2), '');
    assert.equal(identity('member', 90), '', 'member principals never fall back to staff identity');
    for (const role of ['anon', 'authenticated']) {
      assert.equal(sql(`SELECT has_function_privilege('${role}','sales_project_actor_identity(uuid,text,uuid)','execute')`), 'f');
    }
    const staffCreate = (action, boardId = null, actor = 90, suppliedIdentity = actor) =>
      `public.create_sales_opportunity_with_project('${u(1)}','tenant_user','${u(actor)}','${u(suppliedIdentity)}',
        '${row('Unified staff opportunity', { owner_kind: 'tenant_user', owner_id: u(actor) })}'::jsonb,
        '${action}',${boardId ? `'${boardId}'` : 'NULL'})`;
    const staff = JSON.parse(sql(`SET ROLE service_role; SELECT ${staffCreate('create')};`));
    assert.equal(staff.owner_id, u(90));
    assert.equal(sql(`SELECT visibility||'|'||created_by FROM project_board WHERE id='${staff.project_board_id}'`), `private|${u(90)}`);
    assert.equal(sql(`SELECT role FROM project_board_member WHERE board_id='${staff.project_board_id}' AND identity_id='${u(90)}'`), 'owner');
    assert.equal(sql(`SELECT count(*) FROM project_label WHERE board_id='${staff.project_board_id}'`), '6');
    const eligible = sql(`INSERT INTO project_board(tenant_id,name,visibility,created_by)
      VALUES('${u(1)}','Existing private board','private','${u(90)}') RETURNING id`);
    sql(`INSERT INTO project_board_member(board_id,identity_id,role) VALUES('${eligible}','${u(90)}','member')`);
    const beforeDenied = count('opportunity');
    rejects(`PERFORM ${staffCreate('link', eligible)};`, '42501');
    rejects(`PERFORM ${staffCreate('create', null, 90, 20)};`, '42501');
    assert.equal(count('opportunity'), beforeDenied, 'failed link and forged identity create no orphan opportunities');
    sql(`UPDATE project_board_member SET role='admin' WHERE board_id='${eligible}' AND identity_id='${u(90)}'`);
    const staffLinked = JSON.parse(sql(`SET ROLE service_role; SELECT ${staffCreate('link', eligible)};`));
    assert.equal(staffLinked.project_board_id, eligible);
    sql(`UPDATE tenant_membership SET status='inactive' WHERE identity_id='${u(90)}' AND role='admin'`);
    assert.equal(identity('tenant_user', 90), '', 'revocation is rechecked at write time');
    rejects(`PERFORM public.sales_project_attach_board('${u(1)}','${staff.id}','No retry','tenant_user','${u(90)}','${u(90)}','create',NULL);`, '42501');
  } finally {
    if (started) spawnSync('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop']);
    await rm(root, { recursive: true, force: true });
  }
});
