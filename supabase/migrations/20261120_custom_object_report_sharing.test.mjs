import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
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
    const tenant = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', object = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const share = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', grant = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    sql(`INSERT INTO custom_object_report_share(id,tenant_id,custom_object_id,report_id,token_hash,name,definition,source_hash,updated_by)
      VALUES('${share}','${tenant}','${object}','r_report',repeat('a',64),'Report','{}',repeat('b',64),'admin');
      INSERT INTO custom_object_report_share_grant(id,tenant_id,share_id,revision,token_hash,expires_at)
      VALUES('${grant}','${tenant}','${share}',1,repeat('c',64),now()+interval '1 hour');`);
    denied(`INSERT INTO custom_object_report_share_grant(tenant_id,share_id,revision,token_hash,expires_at)
      VALUES('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','${share}',1,repeat('e',64),now()+interval '1 hour');`);
    for (const role of ['anon', 'authenticated']) {
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
