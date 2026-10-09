import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootPath = fileURLToPath(new URL('../../', import.meta.url));
const u = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const migration = path.join(rootPath, 'supabase/migrations/202610090001_sales_project_tasks.sql');
const base = `
 CREATE EXTENSION IF NOT EXISTS pgcrypto;
 CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
 CREATE TABLE tenant(id uuid PRIMARY KEY);
 CREATE TABLE organization(id uuid PRIMARY KEY,tenant_id uuid NOT NULL,name text);
 CREATE TABLE tenant_identity(id varchar PRIMARY KEY,first_name text,last_name text,email text);
 CREATE TABLE member(id uuid PRIMARY KEY,tenant_id uuid NOT NULL,organization_id uuid,identity_id text,first_name text,last_name text,email text);
 CREATE TABLE tenant_user(id uuid PRIMARY KEY,tenant_id uuid NOT NULL,identity_id varchar,first_name text,last_name text,email text);
 CREATE TABLE event(id uuid PRIMARY KEY,tenant_id uuid NOT NULL);
`;
test('Sales Projects migration: isolation, grants, atomic linking, modes, paging, preservation and concurrent create', { timeout: 45000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sales-projects-'));
  const data = path.join(root, 'data'), socket = path.join(root, 'socket');
  await mkdir(socket);
  const args = ['-h', socket, '-p', '55448', '-U', 'postgres', '-d', 'postgres', '--no-psqlrc', '-v', 'ON_ERROR_STOP=1', '-q', '-t', '-A'];
  const run = (command, args, input = '') => {
    const r = spawnSync(command, args, { input, encoding: 'utf8', maxBuffer: 2e6 });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    return r.stdout.trim();
  };
  const sql = text => run('psql', args, text);
  const apply = file => run('psql', [...args, '-f', file]);
  const call = (action, version, op = 30, board = null, kind = 'member', actor = 10, identity = 20, admin = false) =>
    `SELECT public.change_sales_project('${u(1)}','${u(op)}','${kind}','${u(actor)}',${admin},'${u(identity)}',${version},'${action}',${['project','standard'].includes(board) ? `'${board}'` : 'NULL'},${typeof board === 'number' ? `'${u(board)}'` : 'NULL'});`;
  const rejects = (statement, code) => sql(`DO $test$ BEGIN
    BEGIN ${statement} RAISE EXCEPTION 'expected rejection'; EXCEPTION WHEN SQLSTATE '${code}' THEN NULL; END;
    END $test$;`);
  const read = (options, actor = 10, identity = 20, tenant = 1, admin = false) => JSON.parse(sql(
    `SELECT list_sales_project_tasks('${u(tenant)}','member','${u(actor)}',${admin},'${u(identity)}','${JSON.stringify(options)}');`));
  let started = false;
  try {
    run('initdb', ['-D', data, '-A', 'trust', '-U', 'postgres', '--no-instructions']);
    run('pg_ctl', ['-D', data, '-l', path.join(root, 'postgres.log'), '-o', `-F -k ${socket} -c listen_addresses= -p 55448`, '-w', 'start']);
    started = true;
    sql(base);
    apply(path.join(rootPath, 'scripts/migrations/add-project-management.sql'));
    apply(path.join(rootPath, 'supabase/migrations/20260908_opportunity_pipeline.sql'));
    apply(migration);
    sql(`
      INSERT INTO tenant VALUES('${u(1)}'),('${u(2)}');
      INSERT INTO organization VALUES('${u(5)}','${u(1)}','Customer'),('${u(6)}','${u(2)}','Private customer');
      INSERT INTO tenant_identity VALUES('${u(20)}','Alex','Owner','alex@example.test'),('${u(21)}','Pat','Viewer','pat@example.test');
      INSERT INTO member VALUES('${u(10)}','${u(1)}','${u(5)}','${u(20)}','Alex','Owner','alex@example.test'),
        ('${u(11)}','${u(1)}','${u(5)}','${u(21)}','Pat','Viewer','pat@example.test'),
        ('${u(12)}','${u(2)}','${u(6)}',NULL,'Other','Tenant','other@example.test');
      INSERT INTO opportunity_stage(id,tenant_id,name,position) VALUES('${u(7)}','${u(1)}','Open',0),('${u(8)}','${u(2)}','Open',0);
      INSERT INTO opportunity(id,tenant_id,organization_id,stage_id,owner_kind,owner_id,name,created_by_kind,created_by_id)
      VALUES('${u(30)}','${u(1)}','${u(5)}','${u(7)}','member','${u(10)}','A deal','member','${u(10)}'),
        ('${u(31)}','${u(1)}','${u(5)}','${u(7)}','member','${u(10)}','B deal','member','${u(10)}'),
        ('${u(32)}','${u(1)}','${u(5)}','${u(7)}','member','${u(10)}','C deal','member','${u(10)}'),
        ('${u(33)}','${u(2)}','${u(6)}','${u(8)}','member','${u(12)}','Secret','member','${u(12)}');
      INSERT INTO opportunity_task(id,tenant_id,opportunity_id,title,created_by_kind,created_by_id)
        VALUES('${u(70)}','${u(1)}','${u(30)}','Preserve legacy task','member','${u(10)}');
      GRANT USAGE ON SCHEMA public TO service_role,anon,authenticated;
      GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
    `);
    assert.equal(read({ source: 'standard', scope: 'all' }).total, 1);
    assert.equal(sql(`SELECT has_function_privilege('anon','change_sales_project(uuid,uuid,text,uuid,boolean,uuid,integer,text,text,uuid)','execute')`), 'f');
    assert.equal(sql(`SELECT has_table_privilege('authenticated','sales_opportunity_project','select')`), 'f');
    assert.equal(sql(`SELECT has_function_privilege('service_role','list_sales_project_tasks(uuid,text,uuid,boolean,uuid,jsonb)','execute')`), 't');
    rejects(call('create', 1, 30, null, 'member', 11, 21).replace('SELECT public.', 'PERFORM public.'), '42501');
    rejects(call('create', 1, 30, null, 'member', 10, 21).replace('SELECT public.', 'PERFORM public.'), '42501');
    // Success as actual service_role, including final audit insert.
    assert.deepEqual(JSON.parse(sql(`SET ROLE service_role; ${call('create', 1)}`)), { success: true });
    const board = sql(`SELECT board_id FROM sales_opportunity_project WHERE opportunity_id='${u(30)}'`);
    assert.equal(sql(`SELECT name FROM project_board WHERE id='${board}'`), 'A deal');
    assert.equal(sql(`SELECT count(*) FROM project_label WHERE board_id='${board}'`), '6');
    rejects(call('create', 1).replace('SELECT public.', 'PERFORM public.'), '40001');
    rejects(call('create', 2).replace('SELECT public.', 'PERFORM public.'), '23505');
    assert.equal(sql('SELECT count(*) FROM project_board'), '1');
    sql(`
      INSERT INTO project_list(id,board_id,name,position) VALUES('${u(40)}','${board}','To do',0);
      INSERT INTO project_card(id,list_id,board_id,title,due_date,priority,is_complete,created_by)
        VALUES('${u(50)}','${u(40)}','${board}','Overdue',now()-interval '2 days','high',false,'${u(20)}'),
        ('${u(51)}','${u(40)}','${board}','Complete',now()-interval '3 days','low',true,'${u(20)}'),
        ('${u(52)}','${u(40)}','${board}','Later',now()+interval '3 days','urgent',false,'${u(20)}');
      INSERT INTO project_card_assignee(card_id,identity_id) VALUES('${u(50)}','${u(20)}');
      INSERT INTO project_board_member(board_id,identity_id,role) VALUES('${board}','${u(21)}','viewer');
    `);
    const all = read({ source: 'project', scope: 'all' });
    assert.equal(all.total, 3);
    assert.equal(all.summary.overdue, 1);
    assert.equal(all.items.find(t => t.id === u(50)).assignees[0].name, 'Alex Owner');
    assert.equal(read({ scope: 'my' }).total, 1);
    assert.equal(read({ scope: 'all', overdue: true }).total, 1);
    assert.equal(read({ scope: 'all', status: 'completed' }).total, 1);
    assert.equal(read({ scope: 'all', listName: 'Missing' }).total, 0);
    assert.equal(read({ scope: 'all', sort: 'priority' }).items[0].title, 'Later');
    const first = read({ scope: 'all', pageSize: 1 }).items[0].id;
    assert.notEqual(read({ scope: 'all', pageSize: 1, page: 2 }).items[0].id, first);
    assert.equal(read({ scope: 'all' }, 11, 21).total, 0, 'Board membership is not Sales access');
    assert.equal(read({ scope: 'all' }, 10, 21, 2, true).total, 0, 'No tenant leakage');
    sql(`INSERT INTO opportunity_collaborator(tenant_id,opportunity_id,principal_kind,principal_id,added_by_kind,added_by_id)
      VALUES('${u(1)}','${u(30)}','member','${u(11)}','member','${u(10)}');`);
    assert.equal(read({ scope: 'all' }, 11, 21).items[0].canEdit, false, 'Viewer stays read-only');
    sql(`DELETE FROM project_board_member WHERE identity_id='${u(21)}';`);
    assert.equal(read({ scope: 'all' }, 11, 21).total, 0, 'Sales collaborator is not board membership');
    sql(call('mode', 2, 30, 'standard'));
    assert.equal(read({ scope: 'all' }).total, 0);
    assert.equal(read({ source: 'standard', scope: 'all' }).total, 1);
    assert.equal(sql('SELECT count(*) FROM project_card'), '3');
    sql(call('mode', 3, 30, 'project'));
    assert.equal(read({ scope: 'all' }).total, 3);
    sql(`UPDATE project_board SET is_archived=true WHERE id='${board}';`);
    assert.equal(read({ scope: 'all' }).total, 0);
    sql(`UPDATE project_board SET is_archived=false WHERE id='${board}';`);
    apply(migration);
    assert.equal(read({ scope: 'all' }).total, 3, 'Replay retains records and mode');
    sql(call('unlink', 4));
    assert.equal(sql('SELECT count(*) FROM project_card'), '3');
    assert.equal(sql('SELECT count(*) FROM opportunity_task'), '1');
    assert.equal(sql('SELECT count(*) FROM sales_opportunity_project'), '0');
    // Real parallel create submissions share expected version. Exactly one board
    // and link may commit; the other must fail after acquiring the row lock.
    const concurrent = () => new Promise(resolve => {
      const p = spawn('psql', args, { stdio: ['pipe', 'pipe', 'pipe'] });
      p.stdout.resume(); p.stderr.resume();
      p.on('exit', code => resolve(code));
      p.stdin.end(call('create', 1, 31));
    });
    assert.deepEqual((await Promise.all([concurrent(), concurrent()])).sort(), [0, 3]);
    assert.equal(sql(`SELECT count(*) FROM project_board WHERE name='B deal'`), '1');
    // Cross-tenant FK + board uniqueness cannot be bypassed by direct service writes.
    rejects(`INSERT INTO sales_opportunity_project(tenant_id,opportunity_id,board_id)
      VALUES('${u(2)}','${u(33)}','${board}');`, '23503');
    sql(`SELECT change_sales_project('${u(1)}','${u(32)}','member','${u(10)}',false,'${u(20)}',1,'link',NULL,'${board}');`);
    rejects(`INSERT INTO sales_opportunity_project(tenant_id,opportunity_id,board_id)
      VALUES('${u(1)}','${u(30)}','${board}');`, '23505');
    sql(`DELETE FROM project_board WHERE id='${board}';`);
    assert.equal(sql(`SELECT count(*) FROM sales_opportunity_project WHERE opportunity_id='${u(32)}'`), '0');
    assert.equal(sql(`SELECT count(*) FROM opportunity_task`), '1');
    const bulkBoard = sql(`SELECT board_id FROM sales_opportunity_project WHERE opportunity_id='${u(31)}'`);
    sql(`INSERT INTO project_list(id,board_id,name,position) VALUES('${u(41)}','${bulkBoard}','Bulk',0);
      INSERT INTO project_card(list_id,board_id,title,created_by)
      SELECT '${u(41)}','${bulkBoard}','Task '||n,'${u(20)}' FROM generate_series(1,1105) n;`);
    const lastPage = read({ scope: 'all', page: 12, pageSize: 100 });
    assert.equal(lastPage.total, 1105, 'Counts are not truncated by PostgREST caps');
    assert.equal(lastPage.items.length, 5, 'Later pages remain accessible');
  } finally {
    if (started) spawnSync('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop']);
    await rm(root, { recursive: true, force: true });
  }
});
