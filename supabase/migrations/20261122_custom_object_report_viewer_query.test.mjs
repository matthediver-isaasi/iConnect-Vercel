import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { normalizeReportViewerQuery, matchesReportViewerQuery } from '../../shared/reportViewerQuery.mjs';

test('viewer migration filters complete snapshots before paging, preserves order and locks down RPCs', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'report-viewer-query-'));
  const data = path.join(root, 'data'), socket = path.join(root, 'socket');
  await mkdir(socket);
  const port = String(22000 + process.pid % 15000);
  const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  let started = false, client;
  const tenant = '11111111-1111-4111-8111-111111111111';
  const object = '22222222-2222-4222-8222-222222222222';
  const job = '33333333-3333-4333-8333-333333333333';
  const share = '44444444-4444-4444-8444-444444444444';
  const grant = '55555555-5555-4555-8555-555555555555';
  try {
    run('initdb', ['-D', data, '-A', 'trust', '-U', 'postgres', '--no-instructions']);
    run('pg_ctl', ['-D', data, '-l', path.join(root, 'postgres.log'), '-o', `-F -k ${socket} -c listen_addresses= -p ${port}`, '-w', 'start']);
    started = true;
    client = new pg.Client({ host: socket, port: Number(port), user: 'postgres', database: 'postgres' });
    await client.connect();
    const sql = (query, params) => client.query(query, params);
    await sql('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role');
    for (const file of ['20261120_custom_object_report_sort.sql', '20261120_custom_object_report_sharing.sql']) {
      await sql(await readFile(new URL(file, import.meta.url), 'utf8'));
    }
    const migration = await readFile(new URL('20261122_custom_object_report_viewer_query.sql', import.meta.url), 'utf8');
    await sql(migration);
    await sql(migration);
    for (const role of ['anon', 'authenticated']) {
      const privileges = await sql(`SELECT has_table_privilege($1,'custom_object_report_sort_row','SELECT') AS rows,
        has_function_privilege($1,'custom_object_report_viewer_page(uuid,uuid,jsonb,bigint,integer)','EXECUTE') AS page,
        has_function_privilege($1,'custom_object_report_viewer_matches(jsonb,jsonb)','EXECUTE') AS predicate`, [role]);
      assert.deepEqual(privileges.rows[0], { rows: false, page: false, predicate: false });
    }
    await sql(`INSERT INTO custom_object_report_share
      (id,tenant_id,custom_object_id,report_id,token_hash,name,definition,source_hash,updated_by)
      VALUES($1,$2,$3,'report',repeat('a',64),'Report','{}',repeat('b',64),'fixture')`, [share, tenant, object]);
    await sql(`INSERT INTO custom_object_report_share_grant(id,tenant_id,share_id,revision,token_hash,expires_at)
      VALUES($1,$2,$3,1,repeat('c',64),now()+interval '1 day')`, [grant, tenant, share]);
    await sql(`INSERT INTO custom_object_report_sort_job(id,tenant_id,custom_object_id,mode,definition,sort_rules,
      headers,filename,requested_by_report_grant_id,expires_at,status,processed,total)
      VALUES($1,$2,$3,'preview','{}','[]','["Name","City","Flag"]','test.csv',$4,now()+interval '1 day','ready',1004,1004)`,
    [job, tenant, object, grant]);
    await sql(`INSERT INTO custom_object_report_sort_row(tenant_id,job_id,row_identity,row_values,sort_values,position)
      SELECT $1,$2,'r'||n,jsonb_build_array('Department '||n,CASE WHEN n>1000 THEN 'Oxford' ELSE 'London' END,n%2=1),'[]',n
      FROM generate_series(1,1003) n`, [tenant, job]);
    await sql(`INSERT INTO custom_object_report_sort_row(tenant_id,job_id,row_identity,row_values,sort_values,position)
      VALUES($1,$2,'literal',$3,'[]',1004)`, [tenant, job, JSON.stringify(["100%_* O'Brien", '   ', false])]);
    const page = async (query, offset = 0, limit = 50, targetTenant = tenant) => (await sql(
      'SELECT custom_object_report_viewer_page($1,$2,$3,$4,$5) AS page',
      [targetTenant, job, JSON.stringify(query), offset, limit])).rows[0].page;
    let result = await page({ search: 'OXFORD', filters: [] }, 0, 2);
    assert.equal(result.total, 3);
    assert.deepEqual(result.data.map(row => row.id), ['r1001', 'r1002']);
    assert.deepEqual((await page({ search: 'oxford', filters: [] }, 2, 2)).data.map(row => row.id), ['r1003']);
    const combined = { search: 'oxford', filters: [{ column: 2, operator: 'equals', value: 'TRUE' }] };
    result = await page(combined);
    assert.equal(result.total, 2);
    assert.deepEqual(result.data.map(row => row.id), ['r1001', 'r1003']);
    assert.equal((await page({ search: '%_*', filters: [] })).total, 1);
    assert.equal((await page({ search: "O'Brien", filters: [] })).total, 1);
    assert.equal((await page({ search: '', filters: [{ column: 1, operator: 'empty', value: '' }] })).total, 1);
    assert.deepEqual(await page({ search: 'no-such-city', filters: [] }), { data: [], total: 0 });
    await assert.rejects(page({ search: '', filters: [] }, 0, 50, object), /unavailable/);
    await assert.rejects(page({ search: '', filters: [{ column: 3, operator: 'empty', value: '' }] }), /Invalid/);
    await assert.rejects(page({ search: 'no-match', filters: [{ column: 3, operator: 'empty', value: '' }] }), /Invalid/);
    await assert.rejects(page({ search: 'x'.repeat(201), filters: [] }), /Invalid/);
    await assert.rejects(page({ search: '', filters: [] }, -1), /Invalid/);
    await assert.rejects(page({ search: '', filters: [] }, 0, 501), /Invalid/);
    const cells = ['Imaging', '   ', false];
    for (const input of [
      { search: 'IMAGING' }, { search: '%' }, { search: "'; DROP TABLE member;--" },
      { filters: [{ column: 0, operator: 'starts_with', value: 'ima' }] },
      { filters: [{ column: 0, operator: 'not_equals', value: 'Imaging' }] },
      { filters: [{ column: 1, operator: 'empty' }] },
      { filters: [{ column: 2, operator: 'not_empty' }] },
    ]) {
      const query = normalizeReportViewerQuery(input, 3);
      const answer = (await sql('SELECT custom_object_report_viewer_matches($1,$2) AS matched',
        [JSON.stringify(cells), JSON.stringify(query)])).rows[0].matched;
      assert.equal(answer, matchesReportViewerQuery(cells, query), JSON.stringify(query));
    }
    await sql("UPDATE custom_object_report_sort_job SET expires_at=now()-interval '1 second' WHERE id=$1", [job]);
    await assert.rejects(page({ search: '', filters: [] }), /unavailable/);
    assert.equal((await sql('SELECT count(*)::int AS count FROM custom_object_report_sort_row')).rows[0].count, 1004);
  } finally {
    await client?.end();
    if (started) run('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop']);
    await rm(root, { recursive: true, force: true });
  }
});
