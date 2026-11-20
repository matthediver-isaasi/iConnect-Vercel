import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createReportSortService } from '../../api/_lib/customObjectReportSort.js';

test('isolated PostgreSQL globally ranks immutable report pages, fences claims and restricts grants', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'report-sort-'));
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
  const tenant = '11111111-1111-4111-8111-111111111111';
  const object = '22222222-2222-4222-8222-222222222222';
  const job = '33333333-3333-4333-8333-333333333333';
  const claim = '44444444-4444-4444-8444-444444444444';
  let started = false;
  try {
    run('initdb', ['-D', data, '-A', 'trust', '-U', 'postgres', '--no-instructions']);
    run('pg_ctl', ['-D', data, '-l', path.join(root, 'postgres.log'), '-o', `-F -k ${socket} -c listen_addresses= -p ${port}`, '-w', 'start']);
    started = true;
    sql('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;');
    sql(await readFile(new URL('./20261120_custom_object_report_sort.sql', import.meta.url), 'utf8'));
    assert.equal(sql(`SELECT has_table_privilege('anon','custom_object_report_sort_row','SELECT');`), 'f');
    assert.equal(sql(`SELECT has_table_privilege('authenticated','custom_object_report_sort_job','INSERT');`), 'f');
    assert.equal(sql(`SELECT has_function_privilege('authenticated','custom_object_report_sort_commit(uuid,uuid,uuid,uuid,integer,jsonb,jsonb,text,boolean)','EXECUTE');`), 'f');
    sql(`INSERT INTO custom_object_report_sort_job(id,tenant_id,custom_object_id,mode,definition,sort_rules,filename,requested_by_member_id,expires_at)
      VALUES('${job}','${tenant}','${object}','preview','{}','[{"index":0,"direction":"asc"},{"index":1,"direction":"desc"}]','test.csv','member-a',now()+interval '1 day');`);
    // Deliberately out-of-order pages: row source order is unrelated to the
    // selected numeric ascending / numeric descending keys.
    for (let page = 1; page <= 6; page++) {
      const lo = (page - 1) * 200 + 1, hi = Math.min(page * 200, 1003);
      sql(`UPDATE custom_object_report_sort_job SET claim_token='${claim}',status='processing' WHERE id='${job}';
        SELECT custom_object_report_sort_commit('${tenant}','${object}','${job}','${claim}',${page},
          (SELECT jsonb_agg(jsonb_build_object('id',lpad(n::text,5,'0'),'values',jsonb_build_array(n%7,n),
            'sort_values',jsonb_build_array(n%7,n))) FROM generate_series(${lo},${hi}) n),
          '["Group","Number"]','page-${page}',${page !== 6});`);
    }
    assert.equal(sql(`SELECT status||':'||processed FROM custom_object_report_sort_job WHERE id='${job}';`), 'ready:1003');
    assert.equal(sql(`SELECT count(*) FROM custom_object_report_sort_row WHERE job_id='${job}' AND position IS NOT NULL;`), '1003');
    assert.equal(sql(`SELECT bool_and(expected=position) FROM
      (SELECT position,row_number() OVER(ORDER BY (row_values->>0)::int ASC,(row_values->>1)::int DESC,row_identity) expected
        FROM custom_object_report_sort_row WHERE job_id='${job}') x;`), 't');
    const ids = [];
    for (let offset = 0; offset < 1003; offset += 200) {
      ids.push(...sql(`SELECT row_identity FROM custom_object_report_sort_row WHERE job_id='${job}'
        AND position>${offset} AND position<=${offset + 200} ORDER BY position;`).split('\n'));
    }
    assert.equal(ids.length, 1003);
    assert.equal(new Set(ids).size, 1003);
    assert.equal(sql(`SELECT row_values->>1 FROM custom_object_report_sort_row WHERE job_id='${job}' AND position=1;`), '1001');
    const invalid = spawnSync('psql', args, { encoding: 'utf8', input:
      `SELECT custom_object_report_sort_commit('${tenant}','${object}','${job}','${claim}',6,'[]','["Group","Number"]','page-6',false);` });
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /claim expired/);
    // Typed scalar dates/booleans, blanks-last for descending, stable ID ties.
    const extra = '55555555-5555-4555-8555-555555555555';
    sql(`INSERT INTO custom_object_report_sort_job(id,tenant_id,custom_object_id,mode,definition,sort_rules,filename,
      requested_by_tenant_user_id,expires_at,status,claim_token) VALUES
      ('${extra}','${tenant}','${object}','export','{}','[{"index":0,"direction":"desc"},{"index":1,"direction":"asc"}]',
        'typed.csv','admin',now()+interval '1 day','processing','${claim}');
      SELECT custom_object_report_sort_commit('${tenant}','${object}','${extra}','${claim}',1,
      '[{"id":"b","values":["2026-01-01",false],"sort_values":["2026-01-01",false]},
        {"id":"a","values":["2026-01-01",false],"sort_values":["2026-01-01",false]},
        {"id":"c","values":["2026-01-01",true],"sort_values":["2026-01-01",true]},
        {"id":"d","values":["2025-01-01",false],"sort_values":["2025-01-01",false]},
        {"id":"e","values":["No related record",true],"sort_values":[null,true]}]',
      '["Date","Enabled"]',null,false);`);
    assert.equal(sql(`SELECT string_agg(row_identity,',' ORDER BY position) FROM custom_object_report_sort_row WHERE job_id='${extra}';`), 'a,b,c,d,e');
    assert.equal(sql(`SELECT count(*) FROM custom_object_report_sort_row WHERE tenant_id='99999999-9999-4999-8999-999999999999';`), '0');
    // Duplicate commits/identities cannot silently replace ranked evidence.
    assert.equal(sql(`SELECT count(*)=count(DISTINCT position) FROM custom_object_report_sort_row WHERE job_id='${job}';`), 't');
    // Exercise the actual API job lifecycle and generated CSV against the real
    // PostgreSQL materialisation/ranking RPC, with only source rows simulated.
    const literal = value => value == null ? 'NULL' : `'${String(typeof value === 'object' ? JSON.stringify(value) : value).replaceAll("'", "''")}'`;
    class Query {
      constructor(table) { this.table = table; this.conditions = []; this.size = ''; }
      select(columns = '*') { this.columns = columns; return this; }
      eq(k, v) { this.conditions.push(`"${k}"=${literal(v)}`); return this; }
      is(k) { this.conditions.push(`"${k}" IS NULL`); return this; }
      gte(k, v) { this.conditions.push(`"${k}">=${literal(v)}`); return this; }
      lt(k, v) { this.conditions.push(`"${k}"<${literal(v)}`); return this; }
      order(k) { this.orderBy = ` ORDER BY "${k}"`; return this; }
      limit(n) { this.size = ` LIMIT ${Number(n)}`; return this; }
      insert(payload) { this.inserting = payload; return this; }
      update(payload) { this.updating = payload; return this; }
      maybeSingle() { this.one = true; return this; }
      single() { this.one = true; return this; }
      then(resolve, reject) {
        try {
          const where = this.conditions.length ? ` WHERE ${this.conditions.join(' AND ')}` : '';
          let query;
          if (this.inserting) query = `INSERT INTO "${this.table}" (${Object.keys(this.inserting).map(k => `"${k}"`).join(',')})
            VALUES (${Object.values(this.inserting).map(literal).join(',')}) RETURNING *`;
          else if (this.updating) query = `UPDATE "${this.table}" SET ${Object.entries(this.updating).map(([k, v]) => `"${k}"=${literal(v)}`).join(',')}
            ${where} RETURNING *`;
          else query = `SELECT ${this.columns || '*'} FROM "${this.table}"${where}${this.orderBy || ''}${this.size}`;
          const text = sql(this.inserting || this.updating
            ? `WITH result AS (${query}) SELECT COALESCE(jsonb_agg(to_jsonb(result)),'[]') FROM result;`
            : `SELECT COALESCE(jsonb_agg(to_jsonb(result)),'[]') FROM (${query}) result;`);
          const rows = JSON.parse(text);
          resolve({ data: this.one ? rows[0] || null : rows, error: null });
        } catch (error) { reject(error); }
      }
    }
    const adapter = { from: table => new Query(table), async rpc(name, args) {
      const text = sql(`SELECT public.${name}(${Object.entries(args).map(([k, v]) => `${k}=>${literal(v)}`).join(',')});`);
      return { data: text ? JSON.parse(text) : null, error: null };
    } };
    const report = { version: 2, columns: [{ id: 'g' }, { id: 'n' }], sort: [
      { column_id: 'g', direction: 'asc' }, { column_id: 'n', direction: 'desc' },
    ] };
    let executedPages = 0;
    const service = createReportSortService({ db: adapter, tenantId: tenant, context: { tenantUserId: 'admin' },
      now: () => new Date().toISOString(), ErrorType: class extends Error { constructor(_, message) { super(message); } },
      async validate(_, definition) { return { report: definition, grain: { hops: [] } }; },
      async execute(_, definition, page) {
        assert.deepEqual(definition, report);
        assert.ok(page.pageSize <= 200);
        executedPages++;
        const start = Number(page.exportCursor || 0), end = Math.min(start + page.pageSize, 1003);
        return { bounded: true, columns: [{ label: 'Group' }, { label: 'Number' }], total: 1003,
          data: Array.from({ length: end - start }, (_, i) => {
            const n = start + i + 1;
            return { id: String(n).padStart(5, '0'), values: [String(n % 7), String(n)], sort_values: [n % 7, n] };
          }), has_more: end < 1003, next_cursor: String(end) };
      } });
    let exported = await service.export(object, { definition: report, name: 'Sorted report' });
    assert.equal(exported.status, 'queued');
    while (exported.status !== 'complete') exported = await service.export(object, { action: 'process', job_id: exported.id });
    assert.equal(exported.processed, 1003);
    assert.equal(executedPages, 6);
    const csv = [];
    for (let index = 0; index < exported.chunk_count; index++) {
      csv.push((await service.export(object, { action: 'chunk', job_id: exported.id, chunk_index: index })).csv_text);
    }
    const lines = csv.join('').replace(/^\uFEFF/, '').trim().split(/\r?\n/);
    assert.equal(lines.shift(), 'Group,Number');
    const exportedNumbers = lines.map(line => Number(line.split(',')[1]));
    assert.deepEqual(exportedNumbers, Array.from({ length: 1003 }, (_, i) => i + 1).sort((a, b) => (a % 7 - b % 7) || b - a));
    assert.equal(executedPages, 6, 'chunk downloads must not re-run changing source queries');
    await assert.rejects(service.preview(object, { definition: report, action: 'page', job_id: exported.id }), /not found/);
    let previewed = await service.preview(object, { definition: report, pageSize: 50 });
    while (previewed.sort_job.status !== 'complete') previewed = await service.preview(object, {
      definition: report, action: 'process', job_id: previewed.sort_job.id, pageSize: 50,
    });
    const page2 = await service.preview(object, { definition: report, action: 'page', job_id: previewed.sort_job.id, page: 2, pageSize: 50 });
    assert.deepEqual([...previewed.data, ...page2.data].map(row => Number(row.values[1])), exportedNumbers.slice(0, 100));
    // Expired snapshots cannot be downloaded; bounded pruning removes their
    // rows in batches instead of cascading an unbounded amount of work.
    sql(`UPDATE custom_object_report_sort_job SET expires_at=now()-interval '1 day' WHERE id='${exported.id}';`);
    await assert.rejects(service.export(object, { action: 'chunk', job_id: exported.id, chunk_index: 0 }), /expired/);
    sql(`SELECT custom_object_report_sort_prune('${tenant}');`);
    assert.equal(sql(`SELECT count(*) FROM custom_object_report_sort_row WHERE job_id='${exported.id}';`), '3');
    sql(`SELECT custom_object_report_sort_prune('${tenant}');`);
    assert.equal(sql(`SELECT count(*) FROM custom_object_report_sort_job WHERE id='${exported.id}';`), '0');
  } finally {
    if (started) run('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop']);
    await rm(root, { recursive: true, force: true });
  }
});
