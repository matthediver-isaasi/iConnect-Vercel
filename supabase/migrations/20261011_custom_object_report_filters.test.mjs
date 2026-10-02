import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const migration = await readFile(new URL('./20261011_custom_object_report_filters.sql', import.meta.url), 'utf8');
const prerequisite = await readFile(new URL('./20261010_custom_object_report_summary.sql', import.meta.url), 'utf8');
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const q = (value) => `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;

test('actual PostgreSQL related filters precede totals, offsets and durable cursors', async (t) => {
  const find = (name) => spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).stdout?.trim();
  const initdb = find('initdb'); const ctl = find('pg_ctl'); const psql = find('psql');
  if (!initdb || !ctl || !psql) return t.skip('PostgreSQL binaries required');
  const root = await mkdtemp(path.join(tmpdir(), 'report-filter-pg-'));
  const data = path.join(root, 'data');
  const port = String(20000 + process.pid % 20000);
  const run = (command, args, input) => {
    const result = spawnSync(command, args, { encoding: 'utf8', input, maxBuffer: 8 * 1024 * 1024 });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout.trim();
  };
  const args = ['-h', root, '-p', port, '-U', 'postgres', '-d', 'postgres', '--no-psqlrc', '-v', 'ON_ERROR_STOP=1', '-q', '-t', '-A'];
  const sql = (input) => run(psql, args, input);
  const bad = (input) => {
    const result = spawnSync(psql, args, { encoding: 'utf8', input });
    assert.notEqual(result.status, 0, result.stdout);
  };
  let started = false;
  try {
    run(initdb, ['-D', data, '-A', 'trust', '-U', 'postgres', '--no-instructions']);
    run(ctl, ['-D', data, '-l', path.join(root, 'postgres.log'),
      '-o', `-F -k ${root} -c listen_addresses= -p ${port}`, '-w', 'start']);
    started = true;
    sql(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE TABLE tenant(id uuid PRIMARY KEY);
      CREATE TABLE custom_object_definition(id uuid PRIMARY KEY,tenant_id uuid,status text);
      CREATE TABLE custom_object_record(id uuid PRIMARY KEY,tenant_id uuid,custom_object_id uuid,archived_at timestamptz,data jsonb);
      CREATE TABLE member(id uuid PRIMARY KEY,tenant_id uuid,first_name text,last_name text,email text);
      CREATE TABLE organization(id uuid PRIMARY KEY,tenant_id uuid,name text,email text);
      CREATE TABLE organization_group(id uuid PRIMARY KEY,tenant_id uuid,name text,email text);
      CREATE TABLE custom_object_relationship_definition(id uuid PRIMARY KEY,tenant_id uuid,
        source_kind text,source_custom_object_id uuid,target_kind text,target_custom_object_id uuid,
        status text,archived_at timestamptz,configuration jsonb,show_on_source boolean,show_on_target boolean);
      CREATE TABLE custom_object_relationship(id uuid PRIMARY KEY,tenant_id uuid,relationship_definition_id uuid,
        source_record_id uuid,target_record_id uuid,archived_at timestamptz,field_values jsonb);
      CREATE TABLE preference_field(id uuid PRIMARY KEY,tenant_id uuid,custom_object_id uuid,
        name text,field_type text,is_active boolean,archived_at timestamptz);
      INSERT INTO tenant VALUES ('${uuid(1)}'),('${uuid(2)}');
      INSERT INTO custom_object_definition VALUES ('${uuid(10)}','${uuid(1)}','active');
    `);
    sql(`INSERT INTO custom_object_record SELECT ('00000000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid,
      '${uuid(1)}','${uuid(10)}',NULL,'{}' FROM generate_series(100,105) n;
      INSERT INTO member VALUES
        ('${uuid(200)}','${uuid(1)}','Alice','Smith','a@example.test'),
        ('${uuid(201)}','${uuid(1)}','Bob','Jones','b@example.test'),
        ('${uuid(202)}','${uuid(2)}','Foreign','Member','foreign@example.test');
      INSERT INTO custom_object_relationship_definition VALUES ('${uuid(20)}','${uuid(1)}',
        'custom_object','${uuid(10)}','member',NULL,'active',NULL,
        '{"relationship_fields":[{"id":"responder","key":"responder","type":"boolean"},{"id":"score","key":"score","type":"number"}]}',true,true);
      INSERT INTO custom_object_relationship VALUES
        ('${uuid(300)}','${uuid(1)}','${uuid(20)}','${uuid(101)}','${uuid(200)}',NULL,'{"responder":false}'),
        ('${uuid(301)}','${uuid(1)}','${uuid(20)}','${uuid(102)}','${uuid(200)}',NULL,'{"responder":true,"score":2}'),
        ('${uuid(302)}','${uuid(1)}','${uuid(20)}','${uuid(102)}','${uuid(201)}',NULL,'{"responder":false,"score":9}'),
        ('${uuid(303)}','${uuid(1)}','${uuid(20)}','${uuid(103)}','${uuid(201)}',NULL,'{}'),
        ('${uuid(304)}','${uuid(1)}','${uuid(20)}','${uuid(104)}','${uuid(202)}',NULL,'{"responder":true}'),
        ('${uuid(305)}','${uuid(1)}','${uuid(20)}','${uuid(105)}','${uuid(200)}',now(),'{"responder":true}');
    `);
    sql(prerequisite); sql(migration);
    sql(`ALTER TABLE member ADD COLUMN organization_id uuid;
      UPDATE member SET organization_id='${uuid(210)}' WHERE id='${uuid(200)}';`);
    const hop = { relationship_definition_id: uuid(20), from_side: 'source', endpoint_kind: 'member', endpoint_custom_object_id: null };
    const yes = { kind: 'relationship_field', relationship_field_id: 'responder', key: 'responder', type: 'boolean', op: 'equals', value: true };
    const filter = (mode = 'none', conditions = [yes]) => ({ mode, path: [hop], conditions });
    const page = (filters, { offset = 0, limit = 2, cursor = null, grain = [], empty = true } = {}) =>
      JSON.parse(sql(`SELECT custom_object_report_filtered_summary_page('${uuid(1)}','custom_object','${uuid(10)}',
        ${q(grain)},${empty},${offset},${limit},${cursor ? `'${cursor}'` : 'NULL'},true,${q(filters)});`));
    const all = page([filter()], { limit: 500 });
    assert.equal(all.total, 5);
    assert.deepEqual(all.rows.map((r) => r.id), [100,101,103,104,105].map(uuid));
    assert.equal(page([filter('any')]).total, 1);
    assert.equal(page([filter('none', [])], { limit: 500 }).total, 3);
    assert.equal(page([filter('any', [])], { limit: 500 }).total, 3);
    const score = { kind: 'relationship_field', relationship_field_id: 'score', key: 'score', type: 'number', op: 'gt', value: 5 };
    assert.equal(page([filter('any', [yes, score])]).total, 0, 'conjunction must not cross sibling edges');
    assert.equal(page([filter('any', [score])]).total, 1);
    const name = { kind: 'field', field: 'first_name', key: 'first_name', type: 'text', op: 'equals', value: 'alice' };
    assert.equal(page([filter('any', [name])]).total, 0, 'equals is case sensitive');
    assert.equal(page([filter('any', [{ ...name, op: 'contains', value: 'ALi' }])]).total, 2);
    assert.equal(page([filter('any', [{ ...name, op: 'contains', value: '%' }])]).total, 0, 'contains is literal');
    assert.equal(page([filter('any', [{
      ...name, field: 'organization_id', key: 'organization_id', value: uuid(210),
    }])]).total, 2);
    assert.equal(page([filter('any', [{ ...yes, op: 'is_empty' }])]).total, 1);
    assert.equal(page([filter(), filter('any', [])]).total, 2, 'filters combine with AND');
    const traversed = [];
    let cursor = null;
    do {
      const batch = page([filter()], { cursor });
      traversed.push(...batch.rows.map((r) => r.id)); cursor = batch.last_cursor;
      if (!batch.has_more) break;
    } while (true);
    assert.deepEqual(traversed, all.rows.map((r) => r.id));
    assert.deepEqual(page([filter()], { cursor }).rows, []);
    assert.equal(page([filter()], { offset: 2 }).rows[0].id, uuid(103));
    // Multi-hop conditions belong to the final edge and endpoint, not the first edge.
    sql(`INSERT INTO organization VALUES ('${uuid(210)}','${uuid(1)}','Survey Team','');
      INSERT INTO custom_object_relationship_definition VALUES ('${uuid(21)}','${uuid(1)}',
        'member',NULL,'organization',NULL,'active',NULL,'{}',true,true);
      INSERT INTO custom_object_relationship VALUES ('${uuid(310)}','${uuid(1)}','${uuid(21)}',
        '${uuid(200)}','${uuid(210)}',NULL,'{}');`);
    const orgHop = { relationship_definition_id: uuid(21), from_side: 'source', endpoint_kind: 'organization', endpoint_custom_object_id: null };
    assert.equal(page([{ mode: 'any', path: [hop, orgHop], conditions: [
      { kind: 'field', field: 'name', key: 'name', type: 'text', op: 'contains', value: 'survey' },
    ] }]).total, 2);
    sql(`UPDATE organization SET tenant_id='${uuid(2)}' WHERE id='${uuid(210)}';`);
    assert.equal(page([{ mode: 'any', path: [hop, orgHop], conditions: [] }]).total, 0);
    // Row-relative reverse traversal: missing inclusive Member row -> Any false, None true.
    const reverse = { relationship_definition_id: uuid(20), from_side: 'target', endpoint_kind: 'custom_object', endpoint_custom_object_id: uuid(10) };
    const missing = page([{ mode: 'none', path: [reverse], conditions: [] }], { grain: [hop], limit: 500 });
    assert.equal(missing.total, 3);
    assert.ok(missing.rows.every((row) => row.record_ids[1] === null));
    assert.equal(page([{ mode: 'any', path: [reverse], conditions: [] }], { grain: [hop], limit: 500 }).total, 4);
    sql(`UPDATE organization SET tenant_id='${uuid(1)}' WHERE id='${uuid(210)}';
      UPDATE member SET email='DeLeTeD_member@DELETED.local' WHERE id='${uuid(200)}';`);
    assert.equal(page([filter('any')]).total, 0, 'deleted sentinel endpoints cannot match');
    assert.equal(page([{ mode: 'any', path: [hop, orgHop], conditions: [] }]).total, 0);
    assert.equal(JSON.parse(sql(`SELECT custom_object_report_filtered_summary_page(
      '${uuid(1)}','member',NULL,'[]',true,0,500,NULL,true,${q([{ mode: 'any', path: [reverse], conditions: [] }])});`)).total, 1,
    'deleted member row endpoints are excluded before filtering');
    sql(`UPDATE member SET email=NULL WHERE id='${uuid(200)}';`);
    assert.equal(page([filter('any')]).total, 1, 'null email remains eligible');
    sql(`INSERT INTO custom_object_definition VALUES ('${uuid(11)}','${uuid(1)}','active');
      INSERT INTO preference_field VALUES ('${uuid(40)}','${uuid(1)}','${uuid(11)}','amount','decimal',true,NULL);
      INSERT INTO custom_object_record VALUES ('${uuid(500)}','${uuid(1)}','${uuid(11)}',NULL,'{"amount":2.5}');
      INSERT INTO custom_object_relationship_definition VALUES ('${uuid(22)}','${uuid(1)}',
        'custom_object','${uuid(10)}','custom_object','${uuid(11)}','active',NULL,'{}',true,true);
      INSERT INTO custom_object_relationship VALUES ('${uuid(320)}','${uuid(1)}','${uuid(22)}',
        '${uuid(100)}','${uuid(500)}',NULL,'{}');`);
    const custom = { mode: 'any', path: [{
      relationship_definition_id: uuid(22), from_side: 'source', endpoint_kind: 'custom_object', endpoint_custom_object_id: uuid(11),
    }], conditions: [{ kind: 'field', field_id: uuid(40), key: 'amount', type: 'decimal', op: 'gte', value: 2.5 }] };
    assert.equal(page([custom]).total, 1);
    custom.conditions[0].op = 'gt';
    assert.equal(page([custom]).total, 0);
    sql(`UPDATE custom_object_record SET data='{"amount":false}' WHERE id='${uuid(500)}';`);
    custom.conditions[0].op = 'is_empty';
    assert.equal(page([custom]).total, 0, 'false is not empty');
    sql(`UPDATE custom_object_record SET data='{"amount":""}' WHERE id='${uuid(500)}';`);
    assert.equal(page([custom]).total, 1);
    sql(`UPDATE custom_object_record SET archived_at=now() WHERE id='${uuid(500)}';`);
    assert.equal(page([custom]).total, 0, 'archived custom endpoints cannot match emptiness');
    for (const invalid of [
      [{ ...filter(), path: [] }], [{ ...filter(), mode: 'every' }],
      [filter('any', [{ ...yes, value: 'true' }])],
      [filter('any', [{ ...yes, key: 'other' }])],
      [filter('any', [{ ...yes, op: 'contains' }])],
      [{ ...filter(), path: [{ ...hop, endpoint_kind: 'organization' }] }],
    ]) {
      bad(`SELECT custom_object_report_filtered_summary_page('${uuid(1)}','custom_object','${uuid(10)}','[]',true,0,2,NULL,true,${q(invalid)});`);
    }
    bad(`SELECT custom_object_report_filtered_summary_page('${uuid(2)}','custom_object','${uuid(10)}','[]',true,0,2,NULL,true,${q([filter()])});`);
    assert.equal(sql(`SELECT has_function_privilege('anon','custom_object_report_filtered_summary_page(uuid,text,uuid,jsonb,boolean,integer,integer,text,boolean,jsonb)','EXECUTE');`), 'f');
    assert.equal(sql(`SELECT has_function_privilege('service_role','custom_object_report_filtered_summary_page(uuid,text,uuid,jsonb,boolean,integer,integer,text,boolean,jsonb)','EXECUTE');`), 't');
    // Sparse matches beyond the first unfiltered page must not disappear.
    sql(`INSERT INTO custom_object_record SELECT ('00000000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid,
      '${uuid(1)}','${uuid(10)}',NULL,'{}' FROM generate_series(1000,4000) n;
      INSERT INTO custom_object_relationship SELECT ('00000000-0000-4000-8000-' || lpad((n+10000)::text,12,'0'))::uuid,
        '${uuid(1)}','${uuid(20)}',('00000000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid,
        '${uuid(200)}',NULL,'{"responder":true}' FROM generate_series(1000,4000) n WHERE n % 701 = 0;`);
    const sparse = page([filter('any')], { limit: 500 });
    assert.equal(sparse.total, 5);
    for (const size of [1, 2, 3]) {
      const ids = []; let after = null;
      do {
        const batch = page([filter('any')], { limit: size, cursor: after });
        ids.push(...batch.rows.map((row) => row.id)); after = batch.last_cursor;
        if (!batch.has_more) break;
      } while (true);
      assert.deepEqual(ids, sparse.rows.map((row) => row.id));
    }
    sql(`UPDATE custom_object_relationship_definition SET status='archived' WHERE id='${uuid(20)}'; DELETE FROM custom_object_record;`);
    bad(`SELECT custom_object_report_filtered_summary_page('${uuid(1)}','custom_object','${uuid(10)}','[]',true,0,2,NULL,true,${q([filter()])});`);
  } finally {
    if (started) run(ctl, ['-D', data, '-m', 'immediate', '-w', 'stop']);
    await rm(root, { recursive: true, force: true });
  }
});