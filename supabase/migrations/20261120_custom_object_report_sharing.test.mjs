import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
test('shared report SQL isolates grants and preserves natural and multi-column order with bounded atomic commits', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'report-sharing-'));
  const data = path.join(root, 'data'), socket = path.join(root, 'socket');
  await mkdir(socket);
  const run = (cmd, args, input) => {
    const result = spawnSync(cmd, args, { input, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout.trim();
  };
  const port = String(22000 + process.pid % 15000);
  const args = ['-h', socket, '-p', port, '-U', 'postgres', '-d', 'postgres', '-X', '-v', 'ON_ERROR_STOP=1', '-Atq'];
  const sql = query => run('psql', args, query);
  const denied = query => assert.notEqual(spawnSync('psql', args, { input: query, encoding: 'utf8' }).status, 0);
  let running = false;
  try {
    run('initdb', ['-D', data, '-U', 'postgres', '-A', 'trust', '--no-locale', '-E', 'UTF8']);
    run('pg_ctl', ['-D', data, '-o', `-k ${socket} -p ${port} -h '' -F -c max_connections=12 -c shared_buffers=16MB`,
      '-l', path.join(root, 'postgres.log'), '-w', 'start']);
    running = true;
    sql('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;');
    const base = await readFile(new URL('./20261120_custom_object_report_sort.sql', import.meta.url), 'utf8');
    const migration = await readFile(new URL('./20261120_custom_object_report_sharing.sql', import.meta.url), 'utf8');
    sql(base); sql(migration); sql(migration);
    sql('CREATE TABLE public.role(id uuid PRIMARY KEY,tenant_id uuid NOT NULL); GRANT ALL ON public.role TO service_role;');
    const internal = await readFile(new URL('./20261120_internal_custom_object_reports.sql', import.meta.url), 'utf8');
    sql(internal); sql(internal);
    const tenant = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', object = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const share = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', grant = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    sql(`INSERT INTO custom_object_report_share(id,tenant_id,custom_object_id,report_id,token_hash,name,definition,source_hash,updated_by)
      VALUES('${share}','${tenant}','${object}','r_report',repeat('a',64),'Report','{}',repeat('b',64),'admin');
      INSERT INTO custom_object_report_share_grant(id,tenant_id,share_id,revision,token_hash,expires_at)
      VALUES('${grant}','${tenant}','${share}',1,repeat('c',64),now()+interval '1 hour');`);
    const role = 'ffffffff-ffff-4fff-8fff-ffffffffffff', foreign = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const foreignShare = 'eeeeeeee-eeee-4eee-8eee-000000000001', foreignRole = 'eeeeeeee-eeee-4eee-8eee-000000000002';
    sql(`INSERT INTO public.role VALUES('${role}','${tenant}'),('${foreignRole}','${foreign}');
      INSERT INTO custom_object_report_share(id,tenant_id,custom_object_id,report_id,token_hash,name,definition,source_hash,updated_by)
      VALUES('${foreignShare}','${foreign}','${object}','r_foreign',repeat('d',64),'Foreign','{}',repeat('b',64),'admin');`);
    const change = (revision, canView = true) => JSON.stringify([{ share_id: share, can_view: canView,
      can_download: false, expected_revision: revision }]);
    const permissionCall = (changes, roleId = role) => `SELECT set_internal_report_role_access('${tenant}','${roleId}','${changes}'::jsonb,'tenant_user:owner')`;
    sql(`SET ROLE service_role; ${permissionCall(change(0))};`);
    assert.equal(sql(`SELECT can_view,can_download,revision FROM custom_object_report_role_access`), 't|f|1');
    sql(`${permissionCall(change(1))};`);
    denied(`${permissionCall(change(1, false))};`);
    const bulk = JSON.stringify([{ share_id: share, can_view: false, can_download: false, expected_revision: 2 },
      { share_id: foreignShare, can_view: true, can_download: false, expected_revision: 0 }]);
    denied(`${permissionCall(bulk)};`);
    denied(`${permissionCall(change(0), foreignRole)};`);
    assert.equal(sql(`SELECT can_view,revision FROM custom_object_report_role_access`), 't|2', 'failed batches roll back earlier permission updates');
    const clients = [new pg.Client({ host: socket, port: Number(port), user: 'postgres', database: 'postgres' }),
      new pg.Client({ host: socket, port: Number(port), user: 'postgres', database: 'postgres' })];
    try {
      await Promise.all(clients.map(client => client.connect()));
      await clients[0].query('BEGIN');
      await clients[0].query(permissionCall(change(2)));
      const concurrent = clients[1].query(permissionCall(change(2, false))).then(() => null, error => error.code);
      await clients[0].query('COMMIT');
      assert.equal(await concurrent, 'PT409', 'a concurrent stale permission write cannot undo another administrator');
    } finally { await Promise.all(clients.map(client => client.end())); }
    assert.equal(sql(`SELECT can_view,revision FROM custom_object_report_role_access`), 't|3');
    denied(`INSERT INTO custom_object_report_share_grant(tenant_id,share_id,revision,token_hash,expires_at,channel,actor_key,permission_revision)
      VALUES('${tenant}','${share}',1,repeat('1',64),now()+interval '1 hour','internal','member:subject',0);`);
    denied(`INSERT INTO custom_object_report_share_grant(tenant_id,share_id,revision,token_hash,expires_at,channel,actor_key)
      VALUES('${tenant}','${share}',1,repeat('2',64),now()+interval '1 hour','external','member:subject');`);
    sql(`INSERT INTO custom_object_report_share_grant(tenant_id,share_id,revision,token_hash,expires_at,channel,actor_key,role_id,permission_revision)
      VALUES('${tenant}','${share}',1,repeat('3',64),now()+interval '1 hour','internal','member:subject','${role}',3);`);
    denied(`INSERT INTO custom_object_report_share_grant(tenant_id,share_id,revision,token_hash,expires_at)
      VALUES('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','${share}',1,repeat('e',64),now()+interval '1 hour');`);
    for (const role of ['anon', 'authenticated']) {
      denied(`SET ROLE ${role}; SELECT * FROM custom_object_report_role_access;`);
      denied(`SET ROLE ${role}; ${permissionCall(change(3))};`);
      denied(`SET ROLE ${role}; SELECT * FROM custom_object_report_share;`);
      denied(`SET ROLE ${role}; SELECT * FROM custom_object_report_share_grant;`);
      denied(`SET ROLE ${role}; SELECT custom_object_report_share_prune('${tenant}');`);
      denied(`SET ROLE ${role}; SELECT custom_object_report_share_commit(NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL);`);
    }
    for (const sorted of [false, true]) {
      const job = sorted ? '11111111-1111-4111-8111-111111111111' : '22222222-2222-4222-8222-222222222222';
      const claim = '33333333-3333-4333-8333-333333333333';
      const rules = sorted ? '[{"index":0,"direction":"desc"}]' : '[]';
      sql(`INSERT INTO custom_object_report_sort_job(id,tenant_id,custom_object_id,mode,definition,sort_rules,filename,
        requested_by_report_grant_id,expires_at) VALUES('${job}','${tenant}','${object}','export','{}','${rules}','report.csv','${grant}',now()+interval '1 hour');`);
      denied(`UPDATE custom_object_report_sort_job SET requested_by_member_id='forged' WHERE id='${job}';`);
      for (let page = 1; page <= 6; page++) {
        const start = (page - 1) * 200, end = Math.min(start + 200, 1003);
        // Identity order intentionally disagrees with the original occurrence
        // order, proving unsorted exports aren't silently re-sorted by ID.
        const rows = Array.from({ length: end - start }, (_, i) => ({
          id: String(1003 - start - i).padStart(5, '0'), values: [String(start + i)], sort_values: [start + i],
        }));
        sql(`UPDATE custom_object_report_sort_job SET status='processing',claim_token='${claim}' WHERE id='${job}';
          SELECT custom_object_report_share_commit('${tenant}','${object}','${job}','${claim}',${page},
            '${JSON.stringify(rows)}','["Number"]','${end}',${end < 1003});`);
      }
      const ordered = JSON.parse(sql(`SELECT jsonb_agg((row_values->>0)::int ORDER BY position) FROM custom_object_report_sort_row WHERE job_id='${job}';`));
      assert.deepEqual(ordered, Array.from({ length: 1003 }, (_, i) => sorted ? 1002 - i : i));
      assert.equal(sql(`SELECT status||':'||processed FROM custom_object_report_sort_job WHERE id='${job}';`), 'ready:1003');
      denied(`SELECT custom_object_report_share_commit('${tenant}','${object}','${job}','${claim}',6,'[]','["Number"]',NULL,false);`);
    }
    sql(`SET ROLE service_role; SELECT count(*) FROM custom_object_report_share; RESET ROLE;`);
  } finally {
    if (running) spawnSync('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop'], { encoding: 'utf8' });
    await rm(root, { recursive: true, force: true });
  }
});
