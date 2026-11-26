import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const u = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
test('task progress: scoped sources, whole-cohort totals, pagination and authentic completion evidence', { timeout: 45000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sales-progress-'));
  const socket = path.join(root, 'socket'), data = path.join(root, 'data');
  await mkdir(socket);
  const run = (command, args, input = '') => {
    const r = spawnSync(command, args, { input, encoding: 'utf8', maxBuffer: 4e6 });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    return r.stdout.trim();
  };
  const args = ['-h', socket, '-p', '55479', '-U', 'postgres', '-d', 'postgres', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1'];
  const sql = text => run('psql', args, text);
  const apply = file => run('psql', [...args, '-f', file]);
  const read = ({ actor = 10, identity = 20, projects = true, admin = false, page = 1, size = 100, tenant = 1, prefix = '' } = {}) =>
    JSON.parse(sql(`${prefix} SELECT sales_opportunity_task_progress('${u(tenant)}','member','${u(actor)}',${admin},${identity ? `'${u(identity)}'` : 'NULL'},${projects},${page},${size});`));
  const complete = (task, flag, actor = 10, patch = {}) => JSON.parse(sql(
    `SET ROLE service_role; SELECT set_sales_task_completion('${u(1)}','${u(30)}','${u(task)}','member','${u(actor)}',${flag},'${JSON.stringify(patch)}');`));
  let started = false;
  try {
    run('initdb', ['-D', data, '-A', 'trust', '-U', 'postgres', '--no-instructions']);
    run('pg_ctl', ['-D', data, '-l', path.join(root, 'log'), '-o', `-F -k ${socket} -c listen_addresses= -p 55479`, '-w', 'start']);
    started = true;
    sql(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE TABLE opportunity_stage(id uuid PRIMARY KEY,tenant_id uuid,is_won boolean,is_lost boolean);
      CREATE TABLE opportunity(id uuid PRIMARY KEY,tenant_id uuid,stage_id uuid,owner_kind text,owner_id uuid,name text,task_mode text,archived_at timestamptz);
      CREATE TABLE opportunity_collaborator(tenant_id uuid,opportunity_id uuid,principal_kind text,principal_id uuid);
      CREATE TABLE opportunity_task(id uuid PRIMARY KEY,tenant_id uuid,opportunity_id uuid,title text,description text,due_at timestamptz,completed_at timestamptz,updated_at timestamptz);
      CREATE TABLE sales_opportunity_project(tenant_id uuid,opportunity_id uuid PRIMARY KEY,board_id uuid);
      CREATE TABLE project_board(id uuid PRIMARY KEY,tenant_id uuid,is_archived boolean);
      CREATE TABLE project_board_member(board_id uuid,identity_id uuid,role text);
      CREATE TABLE project_list(id uuid PRIMARY KEY,board_id uuid,is_archived boolean);
      CREATE TABLE project_card(id uuid PRIMARY KEY,board_id uuid,list_id uuid,is_archived boolean,is_complete boolean,due_date timestamp,completed_at timestamp,completed_by uuid);
      -- Match live identity types (varchar keys vs UUID Sales principals).
      CREATE TABLE tenant_identity(id varchar PRIMARY KEY,first_name varchar,last_name varchar);
      CREATE TABLE tenant_membership(identity_id varchar,tenant_id uuid);
      CREATE TABLE tenant_user(id uuid PRIMARY KEY,tenant_id uuid,first_name varchar,last_name varchar);
      CREATE TABLE member(id uuid PRIMARY KEY,tenant_id uuid,first_name text,last_name text);
    `);
    const migration = 'supabase/migrations/202702030003_sales_task_progress.sql';
    apply(migration);
    apply(migration);
    sql(`
      GRANT USAGE ON SCHEMA public TO service_role,anon,authenticated;
      GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
      ALTER TABLE opportunity_task ENABLE ROW LEVEL SECURITY;
      INSERT INTO opportunity_stage VALUES ('${u(7)}','${u(1)}',false,false),
        ('${u(8)}','${u(1)}',true,false),('${u(9)}','${u(1)}',false,true),('${u(6)}','${u(2)}',false,false);
      INSERT INTO opportunity VALUES
      ('${u(30)}','${u(1)}','${u(7)}','member','${u(10)}','A standard','standard',NULL),
      ('${u(31)}','${u(1)}','${u(7)}','member','${u(10)}','B project','project',NULL),
      ('${u(32)}','${u(1)}','${u(7)}','member','${u(10)}','C empty','standard',NULL),
      ('${u(33)}','${u(1)}','${u(7)}','member','${u(10)}','D restricted','project',NULL),
      ('${u(34)}','${u(1)}','${u(7)}','member','${u(10)}','E missing','project',NULL),
      ('${u(35)}','${u(1)}','${u(7)}','member','${u(10)}','F archived board','project',NULL),
      ('${u(36)}','${u(1)}','${u(8)}','member','${u(10)}','Won','standard',NULL),
      ('${u(37)}','${u(1)}','${u(9)}','member','${u(10)}','Lost','standard',NULL),
      ('${u(38)}','${u(1)}','${u(7)}','member','${u(10)}','Archived','standard',now()),
      ('${u(39)}','${u(1)}','${u(7)}','member','${u(11)}','Invisible','standard',NULL),
      ('${u(40)}','${u(2)}','${u(6)}','member','${u(10)}','Foreign','standard',NULL);
      INSERT INTO project_board VALUES ('${u(50)}','${u(1)}',false),('${u(51)}','${u(1)}',false),
        ('${u(52)}','${u(1)}',true),('${u(53)}','${u(2)}',false);
      INSERT INTO sales_opportunity_project VALUES ('${u(1)}','${u(31)}','${u(50)}'),
        ('${u(1)}','${u(33)}','${u(51)}'),('${u(1)}','${u(35)}','${u(52)}');
      INSERT INTO project_board_member VALUES ('${u(50)}','${u(20)}','viewer'),('${u(52)}','${u(20)}','owner');
      INSERT INTO project_list VALUES ('${u(60)}','${u(50)}',false),('${u(61)}','${u(50)}',true),
        ('${u(62)}','${u(51)}',false);
      INSERT INTO member VALUES ('${u(10)}','${u(1)}','Alex','Member');
      INSERT INTO tenant_identity VALUES ('${u(20)}','Project','Completer'),('not-a-uuid','External','Identity'),
        ('${u(21)}','Unified','Staff');
      INSERT INTO tenant_membership VALUES ('${u(21)}','${u(1)}');
      INSERT INTO opportunity_task(id,tenant_id,opportunity_id,title,due_at,completed_at)
      VALUES ('${u(70)}','${u(1)}','${u(30)}','Complete historical',NULL,'2026-01-01Z'),
        ('${u(71)}','${u(1)}','${u(30)}','Overdue',now()-interval '1 second',NULL),
        ('${u(72)}','${u(1)}','${u(30)}','No due',NULL,NULL),
        ('${u(73)}','${u(1)}','${u(31)}','Inactive legacy',now()-interval '1 day',NULL);
      INSERT INTO project_card VALUES
        ('${u(80)}','${u(50)}','${u(60)}',false,true,NULL,'2026-01-02 03:04','${u(20)}'),
        ('${u(81)}','${u(50)}','${u(60)}',false,false,now()-interval '1 day',NULL,NULL),
        ('${u(82)}','${u(50)}','${u(60)}',true,false,now()-interval '1 day',NULL,NULL),
        ('${u(83)}','${u(50)}','${u(61)}',false,false,now()-interval '1 day',NULL,NULL),
        ('${u(84)}','${u(51)}','${u(62)}',false,false,now()-interval '1 day',NULL,NULL);
    `);
    let result = read({ prefix: 'SET ROLE service_role;' });
    assert.equal(result.total, 6);
    assert.deepEqual(result.summary, {
      opportunityCount: 6, availableOpportunities: 3, restrictedOpportunities: 1, unavailableOpportunities: 2,
      totalTasks: 5, openTasks: 3, completedTasks: 2, overdueTasks: 2, completionPercent: 40, partial: true,
    });
    const [standard, project, empty, restricted, missing, archived] = result.items;
    assert.equal(standard.latestCompletion.actorName, null, 'never infer creator or assignee');
    assert.equal(project.latestCompletion.actorName, 'Project Completer');
    assert.equal(project.totalTasks, 2);
    assert.equal(empty.totalTasks, 0);
    assert.equal(empty.completionPercent, null);
    assert.equal(empty.latestCompletion, null);
    for (const row of [restricted, missing, archived]) {
      assert.equal(row.totalTasks, null);
      assert.equal(row.latestCompletion, null);
    }
    for (let page = 1; page <= 3; page++) {
      const paged = read({ page, size: 2 });
      assert.deepEqual(paged.summary, result.summary);
      assert.deepEqual(paged.items, result.items.slice((page-1)*2,page*2));
    }
    assert.equal(read({ projects: false }).summary.restrictedOpportunities, 4);
    assert.equal(read({ identity: null }).summary.restrictedOpportunities, 4);
    assert.equal(read({ actor: 11 }).total, 1, 'board access never grants Sales visibility');
    assert.equal(read({ actor: 11, admin: true }).items.find(r => r.id===u(31)).status, 'available');
    assert.equal(read({ admin: true, identity: 21 }).items.find(r => r.id===u(31)).status, 'restricted', 'Sales admin never inherits board access');
    assert.equal(read({ tenant: 2 }).items[0].name, 'Foreign');
    sql(`INSERT INTO opportunity_collaborator VALUES('${u(1)}','${u(30)}','member','${u(11)}')`);
    assert.equal(read({ actor: 11 }).total, 2);
    // Strict boundary: due == transaction now is not overdue, future/no due too.
    const boundary = read({ prefix: `BEGIN; UPDATE opportunity_task SET due_at=now() WHERE id='${u(71)}';` });
    assert.equal(boundary.items[0].overdueTasks, 0);
    const first = complete(71,true);
    assert.equal(first.completed_by_id,u(10));
    assert.equal(first.completed_by_kind,'member');
    assert.equal(complete(71,true,11,{ title:'Changed' }).completed_at,first.completed_at);
    assert.equal(complete(71,true,11).completed_by_id,u(10));
    result = read();
    assert.equal(result.items[0].latestCompletion.actorName,'Alex Member');
    assert.equal(result.items[0].completedTasks,2);
    const reopened = complete(71,false);
    assert.equal(reopened.completed_at,null);
    assert.equal(reopened.completed_by_id,null);
    assert.equal(reopened.completed_by_kind,null);
    assert.equal(read().items[0].latestCompletion.actorName,null);
    assert.equal(complete(70,true).completed_at,'2026-01-01T00:00:00+00:00', 'preserve historical timestamp and unknown actor');
    assert.equal(complete(70,true).completed_by_id,null);
    // Timestamp ties have a stable task-ID tiebreak and unified staff names.
    sql(`UPDATE opportunity_task SET completed_at='2026-01-01Z',completed_by_kind='tenant_user',
      completed_by_id='${u(21)}' WHERE id='${u(72)}'`);
    assert.equal(read().items[0].latestCompletion.actorName,null);
    sql(`UPDATE opportunity_task SET completed_at='2026-01-03Z' WHERE id='${u(72)}'`);
    assert.equal(read().items[0].latestCompletion.actorName,'Unified Staff');
    // More than PostgREST's default row cap; no raw task response or truncation.
    sql(`INSERT INTO opportunity_task(id,tenant_id,opportunity_id,title)
      SELECT gen_random_uuid(),'${u(1)}','${u(30)}','Bulk task' FROM generate_series(1,1100)`);
    assert.equal(read().items[0].totalTasks,1103);
    assert.equal(read().summary.completionPercent,0.3,'completion is weighted by all tasks, never opportunity averages');
    sql(`INSERT INTO project_card(id,board_id,list_id,is_complete)
      SELECT gen_random_uuid(),'${u(50)}','${u(60)}',false FROM generate_series(1,1100)`);
    assert.equal(read().items[1].totalTasks,1102);
    sql(`UPDATE project_card SET is_complete=false WHERE id='${u(80)}'`);
    assert.equal(read().items[1].latestCompletion,null);
    assert.equal(read().items[1].completedTasks,0);
    sql(`INSERT INTO sales_opportunity_project VALUES('${u(1)}','${u(30)}','${u(53)}')`);
    assert.equal(read().items[0].totalTasks,1103,'a retained board link never activates the inactive source');
    for (const role of ['anon','authenticated','service_role']) {
      const expected = role === 'service_role' ? 't' : 'f';
      for (const fn of ['sales_opportunity_task_progress(uuid,text,uuid,boolean,uuid,boolean,integer,integer)',
        'set_sales_task_completion(uuid,uuid,uuid,text,uuid,boolean,jsonb)']) {
        assert.equal(sql(`SELECT has_function_privilege('${role}','${fn}','execute')`), expected);
      }
    }
    assert.equal(sql(`SELECT prosecdef FROM pg_proc WHERE oid='sales_opportunity_task_progress(uuid,text,uuid,boolean,uuid,boolean,integer,integer)'::regprocedure`),'f');
    sql(`DO $$ BEGIN BEGIN
      PERFORM set_sales_task_completion('${u(2)}','${u(30)}','${u(70)}','member','${u(10)}',true);
      RAISE EXCEPTION 'expected rejection'; EXCEPTION WHEN SQLSTATE 'P0002' THEN NULL; END; END $$;`);
  } finally {
    if (started) run('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop']);
    await rm(root, { recursive: true, force: true });
  }
});
