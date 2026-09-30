import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const migrationPath = fileURLToPath(
  new URL('./20261010_custom_object_report_summary.sql', import.meta.url),
);
const bnmsSeedPath = fileURLToPath(
  new URL('./20261007_bnms_department_member_report.sql', import.meta.url),
);
const sql = await readFile(
  migrationPath,
  'utf8',
);
const foundationSql = await readFile(
  new URL('./20260825_custom_object_foundation.sql', import.meta.url),
  'utf8',
);

function findExecutable(name) {
  const result = spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    ...options,
  });
  assert.equal(result.status, 0, `${path.basename(command)} failed:\n${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

function runFailure(command, args, expectedError, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    ...options,
  });
  assert.notEqual(result.status, 0, `${path.basename(command)} unexpectedly succeeded`);
  assert.match(result.stderr || result.stdout, expectedError);
}

test('summary page exposes the v2 contract and supports a zero-hop path', () => {
  assert.match(sql, /custom_object_report_summary_page\(\s*p_tenant_id uuid,\s*p_start_kind text,\s*p_start_custom_object_id uuid,\s*p_grain_path jsonb,\s*p_include_empty boolean,\s*p_offset integer,\s*p_limit integer,\s*p_after_cursor text,\s*p_include_total boolean/);
  assert.match(sql, /v_terminal_record text := 'r\.id'/);
  assert.match(sql, /jsonb_build_array\(to_jsonb\(r\.id\)\)/);
  assert.match(sql, /'rows', v_result->'rows'[\s\S]*'last_cursor'/);
});

test('summary validates each active path hop and each actual endpoint', () => {
  assert.match(sql, /jsonb_array_length\(p_grain_path\) > 6/);
  assert.match(sql, /status = 'active'[\s\S]*archived_at IS NULL/);
  assert.match(sql, /source_kind IS DISTINCT FROM v_current_kind/);
  assert.match(sql, /target_custom_object_id IS DISTINCT FROM v_endpoint_object_id/);
  assert.match(sql, /FROM public\.%2\$I endpoint[\s\S]*endpoint\.tenant_id = \$1/);
  assert.match(sql, /endpoint\.custom_object_id = %L::uuid AND endpoint\.archived_at IS NULL/);
  assert.match(sql, /endpoint_definition\.id = v_endpoint_object_id[\s\S]*endpoint_definition\.status = 'active'/);
});

test('summary keeps missing descendants and duplicate edge paths as stable occurrences', () => {
  assert.match(sql, /LEFT JOIN LATERAL/);
  assert.match(sql, /ON %6\$s IS NOT NULL/);
  assert.match(sql, /jsonb_build_array\(CASE WHEN h%1\$s\.edge_id IS NULL THEN ''null''::jsonb/);
  assert.match(sql, /COALESCE\(h%s\.edge_id::text, ''-''\)/);
  assert.doesNotMatch(sql, /jsonb_agg\([^)]*custom_object_relationship/i);
});

test('summary separately counts and aggregates only a bounded deterministic page', () => {
  assert.match(sql, /SELECT count\(\*\)::numeric FROM \(' \|\| v_query/);
  assert.match(sql, /LEAST\(GREATEST\(COALESCE\(p_limit, 1\), 1\), 500\)/);
  assert.match(sql, /v_page_offset integer := GREATEST\(COALESCE\(p_offset, 0\), 0\)/);
  assert.doesNotMatch(sql, /v_page_offset integer := LEAST/);
  assert.match(sql, /v_cursor_predicate := format\('sort_root > %L::uuid'/);
  assert.match(sql, /sort_edge_%s IS NOT DISTINCT FROM %L::uuid/);
  assert.match(sql, /ORDER BY root_scan\.id[\s\S]*OFFSET 0[\s\S]*LIMIT \$4 \+ 1/);
  assert.match(sql, /OFFSET CASE WHEN \$2 IS NULL THEN \$3 ELSE 0 END/);
  assert.match(sql, /SELECT jsonb_agg\(jsonb_build_object\([\s\S]*FROM selected/);
  assert.match(sql, /custom_object_report_relationship_source_order/);
  assert.match(sql, /custom_object_report_relationship_target_order/);
  assert.match(sql, /custom_object_report_member_root_order[\s\S]*public\.member \(tenant_id, id\)/);
  assert.match(sql, /custom_object_report_organization_root_order[\s\S]*public\.organization \(tenant_id, id\)/);
  assert.match(sql, /custom_object_report_organization_group_root_order[\s\S]*public\.organization_group \(tenant_id, id\)/);
  assert.match(
    foundationSql,
    /idx_custom_object_record_tenant_object_active[\s\S]*custom_object_record \(tenant_id, custom_object_id, id\)[\s\S]*WHERE archived_at IS NULL/,
  );
});

test('distinct count validates a path and counts terminal ids without graph arrays', () => {
  assert.match(sql, /custom_object_report_distinct_count\(\s*p_tenant_id uuid,\s*p_start_kind text,\s*p_start_custom_object_id uuid,\s*p_start_record_id uuid,\s*p_path jsonb/);
  assert.match(sql, /JOIN LATERAL \([\s\S]*SELECT e\.%1\$I AS record_id/);
  assert.match(sql, /SELECT count\(DISTINCT %1\$s\)::numeric/);
  assert.match(sql, /custom_object_report_distinct_counts\(\s*p_tenant_id uuid,\s*p_start_kind text,\s*p_start_custom_object_id uuid,\s*p_start_record_ids uuid\[\],\s*p_path jsonb/);
  assert.match(sql, /cardinality\(p_start_record_ids\) > 500/);
  assert.match(sql, /GROUP BY r\.id[\s\S]*LEFT JOIN eligible_counts USING \(record_id\)/);
});

test('both RPCs are server-only and v1 is untouched', () => {
  const page = String.raw`public\.custom_object_report_summary_page\(uuid,text,uuid,jsonb,boolean,integer,integer,text,boolean\)`;
  const count = String.raw`public\.custom_object_report_distinct_count\(uuid,text,uuid,uuid,jsonb\)`;
  const counts = String.raw`public\.custom_object_report_distinct_counts\(uuid,text,uuid,uuid\[\],jsonb\)`;
  for (const signature of [page, count, counts]) {
    assert.match(sql, new RegExp(`REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC`));
    assert.match(sql, new RegExp(`REVOKE ALL ON FUNCTION ${signature} FROM anon, authenticated`));
    assert.match(sql, new RegExp(`GRANT EXECUTE ON FUNCTION ${signature} TO service_role`));
  }
  assert.doesNotMatch(sql, /CREATE OR REPLACE FUNCTION public\.custom_object_report_occurrence_page/);
  assert.match(sql, /NOTIFY pgrst, 'reload schema'/);
});

test('summary RPCs execute against disposable PostgreSQL fixtures', { timeout: 45_000 }, async (t) => {
  const initdb = findExecutable('initdb');
  const pgCtl = findExecutable('pg_ctl');
  const psql = findExecutable('psql');
  if (!initdb || !pgCtl || !psql) {
    t.skip('PostgreSQL command-line tools are unavailable');
    return;
  }

  const root = await mkdtemp(path.join(tmpdir(), 'custom-report-summary-'));
  const dataDir = path.join(root, 'data');
  const socketDir = path.join(root, 'socket');
  const port = String(20000 + (process.pid % 20000));
  run('mkdir', ['-p', socketDir]);
  let started = false;
  const connection = [
    '-h', socketDir, '-p', port, '-U', 'postgres', '-d', 'postgres',
    '--no-psqlrc', '-v', 'ON_ERROR_STOP=1', '-q',
  ];
  const scalar = (input) => run(psql, [...connection, '-t', '-A'], { input });

  try {
    run(initdb, ['-D', dataDir, '-A', 'trust', '-U', 'postgres', '--no-instructions']);
    run(pgCtl, [
      '-D', dataDir,
      '-l', path.join(root, 'postgres.log'),
      '-o', `-F -k ${socketDir} -c listen_addresses= -p ${port}`,
      '-w', 'start',
    ]);
    started = true;

    run(psql, connection, { input: `
      CREATE ROLE anon;
      CREATE ROLE authenticated;
      CREATE ROLE service_role;
      CREATE TABLE public.tenant (id uuid PRIMARY KEY);
      CREATE TABLE public.custom_object_definition (
        id uuid PRIMARY KEY, tenant_id uuid NOT NULL, status text NOT NULL
      );
      CREATE TABLE public.custom_object_record (
        id uuid PRIMARY KEY, tenant_id uuid NOT NULL, custom_object_id uuid NOT NULL,
        data jsonb NOT NULL DEFAULT '{}', archived_at timestamptz
      );
      CREATE INDEX idx_custom_object_record_tenant_object_active
        ON public.custom_object_record (tenant_id, custom_object_id, id)
        WHERE archived_at IS NULL;
      CREATE TABLE public.member (id uuid PRIMARY KEY, tenant_id uuid NOT NULL);
      CREATE TABLE public.organization (id uuid PRIMARY KEY, tenant_id uuid NOT NULL);
      CREATE TABLE public.organization_group (id uuid PRIMARY KEY, tenant_id uuid NOT NULL);
      CREATE TABLE public.custom_object_relationship_definition (
        id uuid PRIMARY KEY, tenant_id uuid NOT NULL,
        source_kind text NOT NULL, source_custom_object_id uuid,
        target_kind text NOT NULL, target_custom_object_id uuid,
        status text NOT NULL, archived_at timestamptz
      );
      CREATE TABLE public.custom_object_relationship (
        id uuid PRIMARY KEY, tenant_id uuid NOT NULL,
        relationship_definition_id uuid NOT NULL,
        source_record_id uuid NOT NULL, target_record_id uuid NOT NULL,
        archived_at timestamptz
      );

      INSERT INTO tenant VALUES
        ('00000000-0000-4000-8000-000000000001'),
        ('00000000-0000-4000-8000-000000000002');
      INSERT INTO custom_object_definition VALUES
        ('10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','active'),
        ('20000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','active'),
        ('30000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','active'),
        ('40000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','draft'),
        ('10000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000002','active');
      INSERT INTO custom_object_record(id,tenant_id,custom_object_id,archived_at) VALUES
        ('a0000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001',NULL),
        ('a0000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001',now()),
        ('a0000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001',NULL),
        ('a0000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001',NULL),
        ('b0000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001',NULL),
        ('b0000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001',NULL),
        ('b0000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001',now()),
        ('c0000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001',NULL),
        ('c0000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001',now());
      INSERT INTO member VALUES
        ('e0000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001'),
        ('e0000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000002');
      INSERT INTO organization VALUES
        ('f0000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001'),
        ('f0000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000002');
      INSERT INTO organization_group VALUES
        ('90000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001'),
        ('90000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000002');

      INSERT INTO custom_object_relationship_definition VALUES
        ('d1000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','custom_object','10000000-0000-4000-8000-000000000001','custom_object','20000000-0000-4000-8000-000000000001','active',NULL),
        ('d2000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','custom_object','20000000-0000-4000-8000-000000000001','custom_object','30000000-0000-4000-8000-000000000001','active',NULL),
        ('d3000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','custom_object','10000000-0000-4000-8000-000000000001','member',NULL,'active',NULL),
        ('d4000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','custom_object','10000000-0000-4000-8000-000000000001','custom_object','40000000-0000-4000-8000-000000000001','active',NULL),
        ('d5000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','custom_object','10000000-0000-4000-8000-000000000001','organization',NULL,'draft',NULL);
      INSERT INTO custom_object_relationship VALUES
        ('81000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','d1000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001',NULL),
        ('81000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','d1000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000002',NULL),
        ('81000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000001','d1000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000003',NULL),
        ('82000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','d2000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','c0000000-0000-4000-8000-000000000001',NULL),
        ('82000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','d2000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000002','c0000000-0000-4000-8000-000000000001',NULL),
        ('82000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000001','d2000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000002','c0000000-0000-4000-8000-000000000002',NULL),
        ('83000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','d3000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000001',NULL),
        ('83000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','d3000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000004','e0000000-0000-4000-8000-000000000002',NULL);
    ` });
    run(psql, [...connection, '-f', migrationPath]);

    const pathJson = `jsonb_build_array(
      jsonb_build_object('relationship_definition_id','d1000000-0000-4000-8000-000000000001','from_side','source','endpoint_kind','custom_object','endpoint_custom_object_id','20000000-0000-4000-8000-000000000001'),
      jsonb_build_object('relationship_definition_id','d2000000-0000-4000-8000-000000000001','from_side','source','endpoint_kind','custom_object','endpoint_custom_object_id','30000000-0000-4000-8000-000000000001')
    )`;
    const multiHop = scalar(`
      SELECT (result->>'total') || ':' || jsonb_array_length(result->'rows') || ':' ||
        (SELECT count(*) FROM jsonb_array_elements(result->'rows') row
         WHERE row->'record_ids'->1 = 'null'::jsonb
           AND row->'record_ids'->2 = 'null'::jsonb
           AND row->'edges'->0 = 'null'::jsonb
           AND row->'edges'->1 = 'null'::jsonb)
      FROM (SELECT custom_object_report_summary_page(
        '00000000-0000-4000-8000-000000000001','custom_object',
        '10000000-0000-4000-8000-000000000001',${pathJson},true,0,20,NULL,true
      ) result) q;
    `);
    assert.equal(multiHop, '4:4:2');

    const duplicateAndDistinct = scalar(`
      SELECT
        (custom_object_report_summary_page(
          '00000000-0000-4000-8000-000000000001','custom_object',
          '10000000-0000-4000-8000-000000000001',${pathJson},false,0,20,NULL,true
        )->>'total') || ':' ||
        custom_object_report_distinct_count(
          '00000000-0000-4000-8000-000000000001','custom_object',
          '10000000-0000-4000-8000-000000000001',
          'a0000000-0000-4000-8000-000000000001',${pathJson}
        );
    `);
    assert.equal(duplicateAndDistinct, '2:1');

    const afterLastChild = scalar(`
      SELECT result->'rows'->0->>'id'
      FROM (SELECT custom_object_report_summary_page(
        '00000000-0000-4000-8000-000000000001','custom_object',
        '10000000-0000-4000-8000-000000000001',${pathJson},true,0,20,
        'a0000000-0000-4000-8000-000000000001/81000000-0000-4000-8000-000000000002/82000000-0000-4000-8000-000000000002',
        false
      ) result) q;
    `);
    assert.equal(
      afterLastChild,
      'a0000000-0000-4000-8000-000000000003/-/-',
      'cursor exhaustion must not synthesize a null child for the cursor root',
    );

    const batchedCounts = scalar(`
      SELECT custom_object_report_distinct_counts(
        '00000000-0000-4000-8000-000000000001','custom_object',
        '10000000-0000-4000-8000-000000000001',
        ARRAY[
          'a0000000-0000-4000-8000-000000000001',
          'a0000000-0000-4000-8000-000000000003',
          'a0000000-0000-4000-8000-000000000002',
          'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
        ]::uuid[],
        ${pathJson}
      );
    `);
    assert.deepEqual(JSON.parse(batchedCounts), [
      { count: 1, record_id: 'a0000000-0000-4000-8000-000000000001' },
      { count: 0, record_id: 'a0000000-0000-4000-8000-000000000003' },
      { count: 0, record_id: 'a0000000-0000-4000-8000-000000000002' },
      { count: 0, record_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
    ]);
    runFailure(psql, connection, /Invalid custom object report distinct counts input/, {
      input: `
        SELECT custom_object_report_distinct_counts(
          '00000000-0000-4000-8000-000000000001','custom_object',
          '10000000-0000-4000-8000-000000000001',
          ARRAY(SELECT md5(n::text)::uuid FROM generate_series(1,501) n),
          '[]'
        );
      `,
    });

    const rootCounts = scalar(`
      SELECT string_agg(custom_object_report_summary_page(
        '00000000-0000-4000-8000-000000000001', kind, object_id,
        '[]', true, 0, 20, NULL, true
      )->>'total', ':' ORDER BY ordinal)
      FROM (VALUES
        (1,'custom_object','10000000-0000-4000-8000-000000000001'::uuid),
        (2,'member',NULL::uuid),
        (3,'organization',NULL::uuid),
        (4,'organization_group',NULL::uuid)
      ) roots(ordinal,kind,object_id);
    `);
    assert.equal(rootCounts, '3:1:1:1');

    const endpointDefense = scalar(`
      SELECT custom_object_report_summary_page(
        '00000000-0000-4000-8000-000000000001','custom_object',
        '10000000-0000-4000-8000-000000000001',
        jsonb_build_array(jsonb_build_object(
          'relationship_definition_id','d3000000-0000-4000-8000-000000000001',
          'from_side','source','endpoint_kind','member'
        )),false,0,20,NULL,true
      )->>'total';
    `);
    assert.equal(endpointDefense, '1');

    for (const invalidPath of [
      `jsonb_build_array(jsonb_build_object('relationship_definition_id','d3000000-0000-4000-8000-000000000001','endpoint_kind','member'))`,
      `jsonb_build_array(jsonb_build_object('relationship_definition_id','d3000000-0000-4000-8000-000000000001','from_side','source'))`,
      `jsonb_build_array(jsonb_build_object('relationship_definition_id','d5000000-0000-4000-8000-000000000001','from_side','source','endpoint_kind','organization'))`,
      `jsonb_build_array(jsonb_build_object('relationship_definition_id','d4000000-0000-4000-8000-000000000001','from_side','source','endpoint_kind','custom_object','endpoint_custom_object_id','40000000-0000-4000-8000-000000000001'))`,
    ]) {
      runFailure(psql, connection, /Invalid custom object report summary/, { input: `
        SELECT custom_object_report_summary_page(
          '00000000-0000-4000-8000-000000000001','custom_object',
          '10000000-0000-4000-8000-000000000001',${invalidPath},true,0,20,NULL,true
        );
      ` });
    }
    runFailure(psql, connection, /Invalid custom object report distinct count/, { input: `
      SELECT custom_object_report_distinct_count(
        '00000000-0000-4000-8000-000000000001','custom_object',
        '10000000-0000-4000-8000-000000000001',
        'a0000000-0000-4000-8000-000000000001',
        jsonb_build_array(jsonb_build_object(
          'relationship_definition_id','d4000000-0000-4000-8000-000000000001',
          'from_side','source','endpoint_kind','custom_object',
          'endpoint_custom_object_id','40000000-0000-4000-8000-000000000001'
        ))
      );
    ` });

    run(psql, connection, { input: `
      INSERT INTO custom_object_record(id,tenant_id,custom_object_id)
      SELECT md5('summary-bulk-' || n)::uuid,
             '00000000-0000-4000-8000-000000000001',
             '10000000-0000-4000-8000-000000000001'
      FROM generate_series(1,520) n;
    ` });
    const outOfRange = scalar(`
      SELECT (result->>'total') || ':' || jsonb_array_length(result->'rows')
      FROM (SELECT custom_object_report_summary_page(
        '00000000-0000-4000-8000-000000000001','custom_object',
        '10000000-0000-4000-8000-000000000001','[]',true,2147483647,500,NULL,true
      ) result) q;
    `);
    assert.equal(outOfRange, '523:0');

    const paging = scalar(`
      WITH first_page AS MATERIALIZED (
        SELECT custom_object_report_summary_page(
          '00000000-0000-4000-8000-000000000001','custom_object',
          '10000000-0000-4000-8000-000000000001','[]',true,0,500,NULL,true
        ) result
      ), second_page AS MATERIALIZED (
        SELECT custom_object_report_summary_page(
          '00000000-0000-4000-8000-000000000001','custom_object',
          '10000000-0000-4000-8000-000000000001','[]',true,999,500,
          first_page.result->>'last_cursor',false
        ) result FROM first_page
      ), first_ids AS (
        SELECT row->>'id' id FROM first_page, jsonb_array_elements(result->'rows') row
      ), second_ids AS (
        SELECT row->>'id' id FROM second_page, jsonb_array_elements(result->'rows') row
      )
      SELECT
        (SELECT count(*) FROM first_ids) || ':' ||
        (SELECT count(*) FROM second_ids) || ':' ||
        (SELECT count(*) FROM first_ids JOIN second_ids USING(id)) || ':' ||
        (SELECT result->>'has_more' FROM first_page) || ':' ||
        (SELECT result->>'has_more' FROM second_page);
    `);
    assert.equal(paging, '500:23:0:true:false');

    run(psql, connection, { input: `
      INSERT INTO member(id,tenant_id)
      SELECT md5('fanout-member-' || n)::uuid,
             '00000000-0000-4000-8000-000000000001'
      FROM generate_series(1,5000) n;
      INSERT INTO custom_object_relationship(
        id,tenant_id,relationship_definition_id,source_record_id,target_record_id
      )
      SELECT md5('fanout-edge-' || n)::uuid,
             '00000000-0000-4000-8000-000000000001',
             'd3000000-0000-4000-8000-000000000001',
             'a0000000-0000-4000-8000-000000000001',
             md5('fanout-member-' || n)::uuid
      FROM generate_series(1,5000) n;
      ANALYZE custom_object_record;
      ANALYZE custom_object_relationship;
      ANALYZE member;
    ` });
    const fanoutPath = `jsonb_build_array(jsonb_build_object(
      'relationship_definition_id','d3000000-0000-4000-8000-000000000001',
      'from_side','source','endpoint_kind','member'
    ))`;
    const performanceStarted = Date.now();
    const fanoutPaging = scalar(`
      WITH first_page AS MATERIALIZED (
        SELECT custom_object_report_summary_page(
          '00000000-0000-4000-8000-000000000001','custom_object',
          '10000000-0000-4000-8000-000000000001',${fanoutPath},
          false,0,100,NULL,false
        ) result
      ), second_page AS MATERIALIZED (
        SELECT custom_object_report_summary_page(
          '00000000-0000-4000-8000-000000000001','custom_object',
          '10000000-0000-4000-8000-000000000001',${fanoutPath},
          false,0,100,first_page.result->>'last_cursor',false
        ) result FROM first_page
      )
      SELECT jsonb_array_length(first_page.result->'rows') || ':' ||
             jsonb_array_length(second_page.result->'rows') || ':' ||
             (SELECT count(*) FROM
                jsonb_array_elements(first_page.result->'rows') a,
                jsonb_array_elements(second_page.result->'rows') b
              WHERE a->>'id' = b->>'id')
      FROM first_page, second_page;
    `);
    assert.equal(fanoutPaging, '100:100:0');
    assert.ok(Date.now() - performanceStarted < 10_000, 'large-fanout keyset pages exceeded 10s');

    const fanoutCursor = scalar(`
      SELECT id
      FROM custom_object_relationship
      WHERE tenant_id = '00000000-0000-4000-8000-000000000001'
        AND relationship_definition_id = 'd3000000-0000-4000-8000-000000000001'
        AND source_record_id = 'a0000000-0000-4000-8000-000000000001'
        AND archived_at IS NULL
      ORDER BY id OFFSET 2500 LIMIT 1;
    `);
    const explain = scalar(`
      SET enable_seqscan = off;
      EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON, COSTS OFF)
      SELECT r.id, edge.id
      FROM (
        SELECT * FROM custom_object_record root_scan
        WHERE root_scan.tenant_id = '00000000-0000-4000-8000-000000000001'
          AND root_scan.custom_object_id = '10000000-0000-4000-8000-000000000001'
          AND root_scan.archived_at IS NULL
          AND root_scan.id >= 'a0000000-0000-4000-8000-000000000001'
        ORDER BY root_scan.id OFFSET 0
      ) r
      LEFT JOIN LATERAL (
        SELECT relationship.id
        FROM custom_object_relationship relationship
        WHERE relationship.tenant_id = '00000000-0000-4000-8000-000000000001'
          AND relationship.relationship_definition_id = 'd3000000-0000-4000-8000-000000000001'
          AND relationship.source_record_id = r.id
          AND relationship.archived_at IS NULL
          AND relationship.id >= CASE
            WHEN r.id = 'a0000000-0000-4000-8000-000000000001'
            THEN '${fanoutCursor}'::uuid
            ELSE '00000000-0000-0000-0000-000000000000'::uuid
          END
          AND (
            SELECT endpoint.id FROM member endpoint
            WHERE endpoint.id = relationship.target_record_id
              AND endpoint.tenant_id = '00000000-0000-4000-8000-000000000001'
            LIMIT 1
          ) IS NOT NULL
        ORDER BY relationship.id
      ) edge ON true
      WHERE (
          r.id > 'a0000000-0000-4000-8000-000000000001'
          OR (
            r.id = 'a0000000-0000-4000-8000-000000000001'
            AND edge.id > '${fanoutCursor}'::uuid
          )
        )
      LIMIT 101;
    `);
    assert.match(explain, /"Node Type": "Limit"/);
    assert.match(explain, /custom_object_report_relationship_source_order/);
    assert.match(explain, /idx_custom_object_record_tenant_object_active/);
    assert.doesNotMatch(explain, /"Node Type": "Sort"/);
    assert.doesNotMatch(explain, /"Sort Method": "top-N heapsort"/);

    const coreExplain = scalar(`
      SET enable_seqscan = off;
      EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON, COSTS OFF)
      SELECT member_root.id
      FROM member member_root
      WHERE member_root.tenant_id = '00000000-0000-4000-8000-000000000001'
        AND member_root.id > '${fanoutCursor}'::uuid
      ORDER BY member_root.id
      LIMIT 101;
    `);
    assert.match(coreExplain, /"Node Type": "Limit"/);
    assert.match(coreExplain, /custom_object_report_member_root_order/);
    assert.doesNotMatch(coreExplain, /"Node Type": "Sort"/);
    assert.doesNotMatch(coreExplain, /"Sort Method": "top-N heapsort"/);
    for (const [table, index] of [
      ['organization', 'custom_object_report_organization_root_order'],
      ['organization_group', 'custom_object_report_organization_group_root_order'],
    ]) {
      const plan = scalar(`
        SET enable_seqscan = off;
        EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON, COSTS OFF)
        SELECT core_root.id
        FROM ${table} core_root
        WHERE core_root.tenant_id = '00000000-0000-4000-8000-000000000001'
          AND core_root.id > '00000000-0000-0000-0000-000000000000'
        ORDER BY core_root.id
        LIMIT 101;
      `);
      assert.match(plan, new RegExp(index));
      assert.doesNotMatch(plan, /"Node Type": "Sort"/);
      assert.doesNotMatch(plan, /"Sort Method": "top-N heapsort"/);
    }

    run(psql, connection, { input: `
      INSERT INTO custom_object_record(id,tenant_id,custom_object_id)
      SELECT md5('multihop-b-' || n)::uuid,
             '00000000-0000-4000-8000-000000000001',
             '20000000-0000-4000-8000-000000000001'
      FROM generate_series(1,3000) n;
      INSERT INTO custom_object_relationship(
        id,tenant_id,relationship_definition_id,source_record_id,target_record_id
      )
      SELECT md5('multihop-first-' || n)::uuid,
             '00000000-0000-4000-8000-000000000001',
             'd1000000-0000-4000-8000-000000000001',
             'a0000000-0000-4000-8000-000000000001',
             md5('multihop-b-' || n)::uuid
      FROM generate_series(1,3000) n;
      INSERT INTO custom_object_relationship(
        id,tenant_id,relationship_definition_id,source_record_id,target_record_id
      )
      SELECT md5('multihop-second-' || n)::uuid,
             '00000000-0000-4000-8000-000000000001',
             'd2000000-0000-4000-8000-000000000001',
             md5('multihop-b-' || n)::uuid,
             'c0000000-0000-4000-8000-000000000001'
      FROM generate_series(1,3000) n;
      ANALYZE custom_object_record;
      ANALYZE custom_object_relationship;
    ` });
    const [multiFirstCursor, multiSecondCursor] = scalar(`
      SELECT first_edge.id || '|' || second_edge.id
      FROM custom_object_relationship first_edge
      JOIN custom_object_relationship second_edge
        ON second_edge.source_record_id = first_edge.target_record_id
       AND second_edge.relationship_definition_id =
           'd2000000-0000-4000-8000-000000000001'
       AND second_edge.archived_at IS NULL
      WHERE first_edge.tenant_id = '00000000-0000-4000-8000-000000000001'
        AND first_edge.relationship_definition_id =
            'd1000000-0000-4000-8000-000000000001'
        AND first_edge.source_record_id =
            'a0000000-0000-4000-8000-000000000001'
        AND first_edge.archived_at IS NULL
      ORDER BY first_edge.id, second_edge.id
      OFFSET 1500 LIMIT 1;
    `).split('|');
    const multiCursor =
      `a0000000-0000-4000-8000-000000000001/${multiFirstCursor}/${multiSecondCursor}`;
    const dynamicMultiPage = scalar(`
      SELECT jsonb_array_length(result->'rows') || ':' || (result->>'has_more')
      FROM (SELECT custom_object_report_summary_page(
        '00000000-0000-4000-8000-000000000001','custom_object',
        '10000000-0000-4000-8000-000000000001',${pathJson},
        false,0,100,'${multiCursor}',false
      ) result) page;
    `);
    assert.equal(dynamicMultiPage, '100:true');

    // This is the generated two-hop statement shape, including root and
    // prefix-aware lateral cursor bounds. It provides planner evidence that
    // the RPC's dynamic SQL stops after the bounded page.
    const multiExplain = scalar(`
      SET enable_seqscan = off;
      EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON, COSTS OFF)
      SELECT r.id, h1.edge_id, h2.edge_id
      FROM (
        SELECT * FROM custom_object_record root_scan
        WHERE root_scan.tenant_id = '00000000-0000-4000-8000-000000000001'
          AND root_scan.custom_object_id = '10000000-0000-4000-8000-000000000001'
          AND root_scan.archived_at IS NULL
          AND root_scan.id >= 'a0000000-0000-4000-8000-000000000001'
        ORDER BY root_scan.id OFFSET 0
      ) r
      LEFT JOIN LATERAL (
        SELECT edge.id edge_id, edge.target_record_id record_id
        FROM custom_object_relationship edge
        WHERE edge.tenant_id = '00000000-0000-4000-8000-000000000001'
          AND edge.relationship_definition_id =
              'd1000000-0000-4000-8000-000000000001'
          AND edge.source_record_id = r.id
          AND edge.archived_at IS NULL
          AND (
            SELECT endpoint.id FROM custom_object_record endpoint
            WHERE endpoint.id = edge.target_record_id
              AND endpoint.tenant_id = '00000000-0000-4000-8000-000000000001'
              AND endpoint.custom_object_id =
                  '20000000-0000-4000-8000-000000000001'
              AND endpoint.archived_at IS NULL
            LIMIT 1
          ) IS NOT NULL
          AND edge.id >= CASE
            WHEN r.id = 'a0000000-0000-4000-8000-000000000001'
            THEN '${multiFirstCursor}'::uuid
            ELSE '00000000-0000-0000-0000-000000000000'::uuid
          END
        ORDER BY edge.id
      ) h1 ON r.id IS NOT NULL
      LEFT JOIN LATERAL (
        SELECT edge.id edge_id, edge.target_record_id record_id
        FROM custom_object_relationship edge
        WHERE edge.tenant_id = '00000000-0000-4000-8000-000000000001'
          AND edge.relationship_definition_id =
              'd2000000-0000-4000-8000-000000000001'
          AND edge.source_record_id = h1.record_id
          AND edge.archived_at IS NULL
          AND (
            SELECT endpoint.id FROM custom_object_record endpoint
            WHERE endpoint.id = edge.target_record_id
              AND endpoint.tenant_id = '00000000-0000-4000-8000-000000000001'
              AND endpoint.custom_object_id =
                  '30000000-0000-4000-8000-000000000001'
              AND endpoint.archived_at IS NULL
            LIMIT 1
          ) IS NOT NULL
          AND edge.id >= CASE
            WHEN r.id = 'a0000000-0000-4000-8000-000000000001'
              AND h1.edge_id IS NOT DISTINCT FROM '${multiFirstCursor}'::uuid
            THEN '${multiSecondCursor}'::uuid
            ELSE '00000000-0000-0000-0000-000000000000'::uuid
          END
        ORDER BY edge.id
      ) h2 ON h1.record_id IS NOT NULL
      WHERE (
          r.id > 'a0000000-0000-4000-8000-000000000001'
          OR (
            r.id = 'a0000000-0000-4000-8000-000000000001'
            AND h1.edge_id > '${multiFirstCursor}'::uuid
          )
          OR (
            r.id = 'a0000000-0000-4000-8000-000000000001'
            AND h1.edge_id IS NOT DISTINCT FROM '${multiFirstCursor}'::uuid
            AND h2.edge_id > '${multiSecondCursor}'::uuid
          )
        )
      LIMIT 101;
    `);
    assert.match(multiExplain, /"Node Type": "Limit"/);
    assert.match(multiExplain, /custom_object_report_relationship_source_order/);
    assert.match(multiExplain, /idx_custom_object_record_tenant_object_active/);
    assert.match(multiExplain, /"Index Cond":[^\n]*CASE WHEN/);
    assert.doesNotMatch(multiExplain, /"Sort Method": "top-N heapsort"/);

    run(psql, [...connection, '-f', migrationPath]);
    const replay = scalar(`
      SELECT count(*) || ':' || (
        custom_object_report_summary_page(
          '00000000-0000-4000-8000-000000000001','custom_object',
          '10000000-0000-4000-8000-000000000001','[]',true,0,1,NULL,true
        )->>'total'
      ) FROM custom_object_record;
    `);
    assert.equal(replay, '3529:523');

    run(psql, connection, { input: `
      ALTER TABLE custom_object_definition
        ADD COLUMN object_key text,
        ADD COLUMN primary_display_field_id uuid;
      ALTER TABLE custom_object_relationship_definition
        ADD COLUMN relationship_key text,
        ADD COLUMN cardinality text,
        ADD COLUMN configuration jsonb NOT NULL DEFAULT '{}';
      CREATE TABLE preference_field (
        id uuid PRIMARY KEY,
        tenant_id uuid NOT NULL,
        custom_object_id uuid,
        entity_scope text NOT NULL,
        is_active boolean NOT NULL,
        name text
      );
      CREATE TABLE system_settings (
        tenant_id uuid NOT NULL,
        setting_key text NOT NULL,
        setting_value text NOT NULL,
        description text,
        PRIMARY KEY (tenant_id, setting_key)
      );
      INSERT INTO tenant VALUES ('ff2df806-b321-4254-b651-3af11fccf1db');
      INSERT INTO preference_field VALUES (
        '71000000-0000-4000-8000-000000000001',
        'ff2df806-b321-4254-b651-3af11fccf1db',
        'cd1ebfd3-3e16-4091-be5a-99992d926f2f',
        'custom_object',true,'department_name'
      );
      INSERT INTO custom_object_definition(
        id,tenant_id,status,object_key,primary_display_field_id
      ) VALUES (
        'cd1ebfd3-3e16-4091-be5a-99992d926f2f',
        'ff2df806-b321-4254-b651-3af11fccf1db',
        'active','org_department',
        '71000000-0000-4000-8000-000000000001'
      );
      INSERT INTO custom_object_relationship_definition(
        id,tenant_id,source_kind,source_custom_object_id,
        target_kind,target_custom_object_id,status,archived_at,
        relationship_key,cardinality,configuration
      ) VALUES
        (
          '72000000-0000-4000-8000-000000000001',
          'ff2df806-b321-4254-b651-3af11fccf1db',
          'custom_object','cd1ebfd3-3e16-4091-be5a-99992d926f2f',
          'organization',NULL,'active',NULL,
          'organisation','many_to_one','{}'
        ),
        (
          '73000000-0000-4000-8000-000000000001',
          'ff2df806-b321-4254-b651-3af11fccf1db',
          'custom_object','cd1ebfd3-3e16-4091-be5a-99992d926f2f',
          'member',NULL,'active',NULL,
          'members','many_to_many',
          '{"relationship_fields":[{"id":"survey-responded","key":"survey_responded","label":"Survey responded","type":"boolean"}]}'
        );
      UPDATE custom_object_record
      SET data = '{"sentinel":"unchanged"}'
      WHERE id = 'a0000000-0000-4000-8000-000000000001';
      INSERT INTO system_settings VALUES (
        'ff2df806-b321-4254-b651-3af11fccf1db',
        'custom_object_reports_cd1ebfd3-3e16-4091-be5a-99992d926f2f',
        '{"theme":{"density":"compact"},"reports":[{"id":"existing","name":"User report","config":{"edited":true}}]}',
        'existing description'
      );
    ` });
    run(psql, [...connection, '-f', bnmsSeedPath]);
    run(psql, connection, { input: `
      UPDATE system_settings
      SET setting_value = jsonb_set(
        setting_value::jsonb,
        '{reports,0,config,edited}',
        '"again"'::jsonb
      )::text
      WHERE tenant_id = 'ff2df806-b321-4254-b651-3af11fccf1db'
        AND setting_key = 'custom_object_reports_cd1ebfd3-3e16-4091-be5a-99992d926f2f';
    ` });
    run(psql, [...connection, '-f', bnmsSeedPath]);
    const seedReplay = scalar(`
      SELECT
        jsonb_array_length(setting_value::jsonb->'reports') || ':' ||
        (setting_value::jsonb->'reports'->0->'config'->>'edited') || ':' ||
        (setting_value::jsonb->'theme'->>'density') || ':' ||
        (SELECT data->>'sentinel' FROM custom_object_record
         WHERE id = 'a0000000-0000-4000-8000-000000000001')
      FROM system_settings
      WHERE tenant_id = 'ff2df806-b321-4254-b651-3af11fccf1db'
        AND setting_key = 'custom_object_reports_cd1ebfd3-3e16-4091-be5a-99992d926f2f';
    `);
    assert.equal(seedReplay, '2:again:compact:unchanged');
  } finally {
    if (started) {
      run(pgCtl, ['-D', dataDir, '-m', 'immediate', '-w', 'stop']);
    }
    await rm(root, { recursive: true, force: true });
  }
});