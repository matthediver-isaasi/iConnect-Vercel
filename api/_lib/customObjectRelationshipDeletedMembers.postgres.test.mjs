import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// No environment database URL is accepted. All SQL runs in this fresh UNIX
// socket cluster under the opt-in network boundary in guides/testing-modes.md.
const base = fileURLToPath(new URL('../../supabase/migrations/20260928_custom_object_relationship_list_rpc.sql', import.meta.url));
const migration = fileURLToPath(new URL('../../supabase/migrations/20261107_custom_object_relationship_deleted_members.sql', import.meta.url));
const id = number => `10000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const q = value => `'${String(value).replaceAll("'", "''")}'`;
const tenant = id(1);
const otherTenant = id(2);
const object = id(3);
const endpointObject = id(4);
const json = value => `${q(JSON.stringify(value))}::jsonb`;
const executable = name => spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).stdout.trim();
const invoke = (command, args, input = '') => spawnSync(command, args, { input, encoding: 'utf8', timeout: 30_000 });
function run(command, args, input = '') {
  const result = invoke(command, args, input);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function item(side, kind = 'member') {
  const n = { member: 10, organization: 12, organization_group: 14, custom_object: 16 }[kind] + (side === 'target' ? 1 : 0);
  return {
    relationship_definition_id: id(n), side, endpoint_kind: kind,
    endpoint_custom_object_id: kind === 'custom_object' ? endpointObject : null,
    list_field_id: `relationship:${id(n)}:${side}`,
    ...(kind === 'custom_object' ? { display_key: 'name' } : {}),
  };
}

function fixture() {
  let sql = `
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE TABLE member (id uuid PRIMARY KEY, tenant_id uuid, email text,
      first_name text, last_name text, login_enabled boolean DEFAULT true, membership_paused boolean DEFAULT false);
    CREATE TABLE organization (id uuid PRIMARY KEY, tenant_id uuid, name text);
    CREATE TABLE organization_group (id uuid PRIMARY KEY, tenant_id uuid, name text);
    CREATE TABLE custom_object_definition (id uuid PRIMARY KEY, tenant_id uuid, status text, primary_display_field_id uuid);
    CREATE TABLE preference_field (id uuid PRIMARY KEY, tenant_id uuid, custom_object_id uuid,
      entity_scope text, is_active boolean, name text);
    CREATE TABLE custom_object_record (id uuid PRIMARY KEY, tenant_id uuid, custom_object_id uuid,
      archived_at timestamptz, data jsonb DEFAULT '{}', created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
    CREATE TABLE custom_object_relationship_definition (id uuid PRIMARY KEY, tenant_id uuid, status text,
      source_kind text, source_custom_object_id uuid, target_kind text, target_custom_object_id uuid,
      show_on_source boolean DEFAULT true, show_on_target boolean DEFAULT true);
    CREATE TABLE custom_object_relationship (id uuid DEFAULT gen_random_uuid(), tenant_id uuid, relationship_definition_id uuid,
      source_record_id uuid, target_record_id uuid, archived_at timestamptz);
    INSERT INTO custom_object_definition VALUES
      (${q(object)},${q(tenant)},'active',${q(id(5))}),
      (${q(endpointObject)},${q(tenant)},'active',${q(id(6))});
    INSERT INTO preference_field VALUES
      (${q(id(5))},${q(tenant)},${q(object)},'custom_object',true,'name'),
      (${q(id(6))},${q(tenant)},${q(endpointObject)},'custom_object',true,'name');
    INSERT INTO member (id,tenant_id,email,first_name,login_enabled,membership_paused) VALUES
      (${q(id(200))},${q(tenant)},'alice@example.test','Alice',true,false),
      (${q(id(201))},${q(tenant)},'deleted_one@deleted.local','A deleted',true,false),
      (${q(id(202))},${q(tenant)},'DeLeTeD_TWO@DeLeTeD.LoCaL','A deleted upper',true,false),
      (${q(id(203))},${q(tenant)},NULL,'Znull',true,false),
      (${q(id(204))},${q(tenant)},'disabled@example.test','Beta',false,true),
      (${q(id(205))},${q(tenant)},'real@example.test','Deleted Member',false,false),
      (${q(id(206))},${q(tenant)},'deleted_@deleted.local','Eempty',true,false),
      (${q(id(207))},${q(tenant)},'deleted_x@deleted.local.evil','Fsuffix',true,false),
      (${q(id(208))},${q(tenant)},'xdeleted_x@deleted.local','Gprefix',true,false),
      (${q(id(209))},${q(otherTenant)},'foreign@example.test','A foreign',true,false),
      (${q(id(210))},${q(tenant)},'archived-edge@example.test','A archived edge',true,false);
    INSERT INTO organization VALUES (${q(id(300))},${q(tenant)},'Deleted Organization');
    INSERT INTO organization_group VALUES (${q(id(301))},${q(tenant)},'Deleted Group');
    INSERT INTO custom_object_record (id,tenant_id,custom_object_id,data) VALUES
      (${q(id(302))},${q(tenant)},${q(endpointObject)},'{"name":"Deleted Custom"}');
  `;
  for (let n = 100; n <= 105; n++) {
    sql += `INSERT INTO custom_object_record (id,tenant_id,custom_object_id,data,archived_at)
      VALUES (${q(id(n))},${q(tenant)},${q(object)},${json({ name: `Record ${n}` })},${n === 104 ? 'now()' : 'NULL'});`;
  }
  sql += `INSERT INTO custom_object_record (id,tenant_id,custom_object_id) VALUES (${q(id(106))},${q(otherTenant)},${q(object)});`;
  for (const side of ['source', 'target']) {
    for (const kind of ['member', 'organization', 'organization_group', 'custom_object']) {
      const i = item(side, kind);
      const oppositeObject = kind === 'custom_object' ? q(endpointObject) : 'NULL';
      sql += `INSERT INTO custom_object_relationship_definition
        (id,tenant_id,status,source_kind,source_custom_object_id,target_kind,target_custom_object_id) VALUES
        (${q(i.relationship_definition_id)},${q(tenant)},'active',
        ${side === 'source' ? `'custom_object',${q(object)},${q(kind)},${oppositeObject}` : `${q(kind)},${oppositeObject},'custom_object',${q(object)}`});`;
      const edge = (r, m, edgeTenant = tenant, archived = false) => `INSERT INTO custom_object_relationship
        (tenant_id,relationship_definition_id,source_record_id,target_record_id,archived_at) VALUES
        (${q(edgeTenant)},${q(i.relationship_definition_id)},${q(id(side === 'source' ? r : m))},${q(id(side === 'source' ? m : r))},${archived ? 'now()' : 'NULL'});`;
      if (kind !== 'member') {
        sql += edge(100, { organization: 300, organization_group: 301, custom_object: 302 }[kind]);
        continue;
      }
      for (let m = 200; m <= 210; m++) sql += edge(100, m, tenant, m === 210);
      sql += edge(101, 201) + edge(101, 202) + edge(103, 209)
        + edge(103, 200, otherTenant) + edge(104, 200) + edge(106, 200, otherTenant);
      // More than a PostgREST default page of deleted edges, followed by more
      // than a page of eligible edges. Counts and filters must see the tail.
      sql += `INSERT INTO custom_object_relationship
        (tenant_id,relationship_definition_id,source_record_id,target_record_id)
        SELECT ${q(tenant)},${q(i.relationship_definition_id)},
          ${side === 'source' ? `${q(id(105))}::uuid,md5('bulk-member-' || n)::uuid` : `md5('bulk-member-' || n)::uuid,${q(id(105))}::uuid`}
        FROM generate_series(1,2305) n;`;
    }
  }
  sql += `INSERT INTO member (id,tenant_id,email,first_name)
    SELECT md5('bulk-member-' || n)::uuid,${q(tenant)},
      CASE WHEN n <= 1100 THEN 'deleted_' || n || '@deleted.local' ELSE n || '@example.test' END,
      CASE WHEN n <= 1100 THEN 'A Deleted' ELSE 'Bulk ' || lpad(n::text,4,'0') END
    FROM generate_series(1,2305) n;
    GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    \\i ${base}
  `;
  return sql;
}

test('deleted member relationship RPCs on a disposable PostgreSQL cluster', { timeout: 90_000 }, async t => {
  assert.equal(process.env.TEST_ISOLATION_ACTIVE, '1', 'Use scripts/run-isolated-tests.mjs');
  assert.equal(process.env.TEST_ISOLATION_ALLOW_LOCAL_PG, '1', 'Use --allow-local-postgres');
  const initdb = executable('initdb');
  const pgCtl = executable('pg_ctl');
  const psql = executable('psql');
  assert.ok(initdb && pgCtl && psql, 'Local PostgreSQL tools required; no fallback database is allowed');
  const root = await mkdtemp(path.join(tmpdir(), 'relationship-deleted-members-'));
  const data = path.join(root, 'data');
  const socket = path.join(root, 'socket');
  await mkdir(socket);
  let started = false;
  try {
    run(initdb, ['-D', data, '--no-locale', '--encoding=UTF8', '--auth=trust', '-U', 'postgres']);
    run(pgCtl, ['-D', data, '-l', path.join(root, 'postgres.log'), '-o', `-k ${socket} -c listen_addresses=''`, '-w', 'start']);
    started = true;
    const args = ['-X', '-h', socket, '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', '-t', '-A'];
    const sql = statement => run(psql, args, statement);
    const rows = statement => JSON.parse(sql(`SET ROLE service_role; SELECT COALESCE(json_agg(result),'[]') FROM (${statement}) result;`));
    const failure = statement => {
      const result = invoke(psql, args, statement);
      assert.notEqual(result.status, 0, 'SQL must fail');
      return result.stderr;
    };
    const list = (filters = [], options = {}) => `SELECT * FROM custom_object_record_relationship_list(
      ${q(options.tenant || tenant)},${q(object)},${options.archived || false},${json(options.scalar || {})},
      ${json(filters)},${options.sort ? json(options.sort) : 'NULL'},${options.offset || 0},${options.limit || 100})`;
    const projection = (i, records = [100, 101, 102, 103, 105], limit = 3) => `SELECT * FROM custom_object_record_relationship_projection(
      ${q(tenant)},${q(object)},${json([i])},ARRAY[${records.map(n => q(id(n))).join(',')}]::uuid[],${limit})`;
    sql(fixture());
    const before = sql("SELECT json_agg(row_to_json(p) ORDER BY p.oid) FROM pg_proc p WHERE proname LIKE 'custom_object_record_relationship_%'");
    const baseSql = await readFile(base, 'utf8');
    const beforeData = sql(`SELECT json_build_array(
      (SELECT count(*) FROM member),(SELECT count(*) FROM custom_object_relationship),
      (SELECT count(*) FROM custom_object_record))`);
    sql(`\\i ${migration}`);

    await t.test('only member joins change; no signatures, OIDs, data, guards or nonmember SQL drift; idempotent', () => {
      const after = JSON.parse(sql("SELECT json_agg(row_to_json(p) ORDER BY p.oid) FROM pg_proc p WHERE proname LIKE 'custom_object_record_relationship_%'"));
      for (const old of JSON.parse(before)) {
        const current = after.find(row => row.oid === old.oid);
        assert.ok(current, 'CREATE OR REPLACE retains routine OID/signature');
        const expected = old.proname.endsWith('_list')
          ? old.prosrc.replace("'JOIN member ep ON ep.id = e.%I AND ep.tenant_id = $1'",
            () => "'JOIN member ep ON ep.id = e.%I AND ep.tenant_id = $1 AND (ep.email IS NULL OR ep.email !~* ''^deleted_.+@deleted[.]local$'')'")
          : old.prosrc.replace('      AND m.tenant_id = p_tenant_id\n    LEFT JOIN organization o',
            () => "      AND m.tenant_id = p_tenant_id\n      AND (m.email IS NULL OR m.email !~* '^deleted_.+@deleted[.]local$')\n    LEFT JOIN organization o");
        assert.notEqual(expected, old.prosrc);
        // PostgreSQL's serialized default expressions include source offsets,
        // which pg_get_functiondef formatting legitimately changes.
        const normalize = row => ({
          ...row,
          proargdefaults: row.proargdefaults?.replaceAll(/:location \d+/g, ':location 0'),
        });
        assert.deepEqual(normalize(current), normalize({ ...old, prosrc: expected }));
      }
      sql(`\\i ${migration}`);
      assert.deepEqual(JSON.parse(sql("SELECT json_agg(row_to_json(p) ORDER BY p.oid) FROM pg_proc p WHERE proname LIKE 'custom_object_record_relationship_%'")), after);
      assert.equal(sql(`SELECT json_build_array(
        (SELECT count(*) FROM member),(SELECT count(*) FROM custom_object_relationship),
        (SELECT count(*) FROM custom_object_record))`), beforeData);
      assert.ok(baseSql.includes("'JOIN member ep ON ep.id = e.%I AND ep.tenant_id = $1'"), 'historical migration remains unchanged');
    });

    for (const side of ['source', 'target']) {
      const i = item(side);
      const filter = (op, values = []) => ({ ...i, op, values });
      const expectIds = (filters, expected, options) => {
        const result = rows(list(filters, options));
        assert.deepEqual(result.filter(row => row.record_id).map(row => row.record_id), expected.map(id));
        assert.ok(result.every(row => row.total_count === expected.length));
      };
      await t.test(`${side}: all filter operators use eligible members only, including NULL/disabled/name-only`, () => {
        expectIds([filter('is_not_empty')], [100, 105]);
        expectIds([filter('is_empty')], [101, 102, 103]);
        expectIds([filter('any_of', [id(201), id(202)])], []);
        expectIds([filter('none_of', [id(201), id(202)])], [100, 101, 102, 103, 105]);
        expectIds([filter('any_of', [id(200), id(201)])], [100]);
        expectIds([filter('none_of', [id(200), id(201)])], [101, 102, 103, 105]);
        for (const n of [203, 204, 205, 206, 207, 208]) expectIds([filter('any_of', [id(n)])], [100]);
        expectIds([filter('any_of', [id(209), id(210)])], []);
        expectIds([filter('is_not_empty')], [100, 104, 105], { archived: true });
      });
      await t.test(`${side}: exact projection counts, stable bounded labels and no deleted-only/foreign entries`, () => {
        const result = rows(projection(i));
        assert.deepEqual(result.filter(row => row.routed_record_id === id(100)).map(row => [row.opposite_record_id, row.total_count]),
          [200, 204, 205].map(n => [id(n), 7]));
        assert.equal(result.length, 6);
        assert.ok(result.every(row => [id(100), id(105)].includes(row.routed_record_id)));
        const expanded = rows(projection(i, [100], 10));
        assert.deepEqual(expanded.map(row => row.opposite_record_id), [200, 204, 205, 206, 207, 208, 203].map(id));
        const bulk = result.filter(row => row.routed_record_id === id(105));
        assert.equal(bulk.length, 3);
        assert.ok(bulk.every(row => row.total_count === 1205));
        assert.deepEqual(bulk.map(row => row.opposite_record_id),
          JSON.parse(sql("SELECT json_agg(md5('bulk-member-' || n)::uuid ORDER BY n) FROM generate_series(1101,1103) n")));
        const tailId = sql("SELECT md5('bulk-member-2305')::uuid");
        expectIds([filter('any_of', [tailId])], [105]);
        assert.deepEqual(rows(list([filter('is_not_empty')], { offset: 1, limit: 1 })), [{ record_id: id(105), total_count: 2 }]);
        assert.deepEqual(rows(list([filter('is_not_empty')], { offset: 99 })), [{ record_id: null, total_count: 2 }]);
      });
      await t.test(`${side}: organization, group and Custom Object filters/projection/sorts remain unchanged`, () => {
        for (const kind of ['organization', 'organization_group', 'custom_object']) {
          const other = item(side, kind);
          const opposite = { organization: 300, organization_group: 301, custom_object: 302 }[kind];
          expectIds([{ ...other, op: 'any_of', values: [id(opposite)] }], [100]);
          expectIds([{ ...other, op: 'none_of', values: [id(opposite)] }], [101, 102, 103, 105]);
          expectIds([{ ...other, op: 'is_empty' }], [101, 102, 103, 105]);
          expectIds([{ ...other, op: 'is_not_empty' }], [100]);
          assert.deepEqual(rows(projection(other, [100])).map(row => [row.opposite_record_id, row.total_count]), [[id(opposite), 1]]);
        }
        for (const mode of ['label', 'count']) {
          const result = rows(list([], { sort: { ...item(side, 'custom_object'), mode, ascending: false } }));
          assert.equal(result[0].record_id, id(100));
          assert.ok(result.every(row => row.total_count === 5));
        }
      });
    }

    await t.test('server-only grants, validation, tenant metadata and scalar plans survive', () => {
      for (const role of ['anon', 'authenticated']) {
        assert.match(failure(`SET ROLE ${role}; ${list()}`), /permission denied/);
        assert.match(failure(`SET ROLE ${role}; ${projection(item('source'))}`), /permission denied/);
      }
      assert.equal(sql(`SELECT count(*) FROM pg_proc p, LATERAL aclexplode(p.proacl) a
        WHERE p.proname LIKE 'custom_object_record_relationship_%' AND a.grantee=0`), '0');
      assert.match(failure(list([], { limit: 1001 })), /Invalid relationship list range/);
      assert.match(failure(projection(item('source'), [100], 11)), /Invalid relationship projection input/);
      assert.match(failure(list([{ ...item('source'), op: 'bogus' }])), /Invalid relationship filter operator/);
      assert.match(failure(list([{ ...item('source'), op: 'any_of', values: [] }])), /non-empty array/);
      assert.match(failure(list([{ ...item('source'), op: 'is_empty' }], { tenant: otherTenant })), /active tenant endpoint/);
      assert.match(failure(projection({ ...item('source'), list_field_id: 'forged' })), /Invalid relationship projection item/);
      sql(`UPDATE custom_object_relationship_definition SET show_on_source=false WHERE id=${q(id(10))}`);
      assert.match(failure(list([{ ...item('source'), op: 'is_empty' }])), /active tenant endpoint/);
      assert.match(failure(projection(item('source'))), /Invalid relationship projection item/);
      sql(`UPDATE custom_object_relationship_definition SET show_on_source=true,status='archived' WHERE id=${q(id(10))}`);
      assert.match(failure(list([{ ...item('source'), op: 'is_empty' }])), /active tenant endpoint/);
      sql(`UPDATE custom_object_relationship_definition SET status='active' WHERE id=${q(id(10))}`);
      const scalar = { filters: [{ kind: 'filter', op: 'eq', column: 'data->>name', value: 'Record 100' }] };
      assert.deepEqual(rows(list([{ ...item('source'), op: 'is_not_empty' }], { scalar })), [{ record_id: id(100), total_count: 1 }]);
      assert.match(failure(list([], { scalar: { filters: [{ kind: 'is_empty', column: 'data->>not_a_field' }] } })), /Invalid scalar list filter/);
    });

    await t.test('unexpected installed member join fails atomically instead of silently skipping', () => {
      const original = sql("SELECT pg_get_functiondef('custom_object_record_relationship_projection(uuid,uuid,jsonb,uuid[],integer)'::regprocedure)");
      sql(original.replace("AND (m.email IS NULL OR m.email !~* '^deleted_.+@deleted[.]local$')", 'AND true'));
      assert.match(failure(`BEGIN;\n\\i ${migration}\nCOMMIT;`), /Unrecognized relationship-list member join/);
      sql(original);
    });
  } finally {
    if (started) run(pgCtl, ['-D', data, '-m', 'immediate', '-w', 'stop']);
    await rm(root, { recursive: true, force: true });
  }
});