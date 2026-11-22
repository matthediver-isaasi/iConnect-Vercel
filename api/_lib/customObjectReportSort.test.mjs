import test from 'node:test';
import assert from 'node:assert/strict';
import { createReportSortService } from './customObjectReportSort.js';
import { matchesReportViewerQuery } from '../../shared/reportViewerQuery.mjs';

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const definition = { version: 2, columns: [{ id: 'amount', label: 'Amount' }], sort: [{ column_id: 'amount', direction: 'asc' }] };
function fixture(changes = {}) {
  const tables = { custom_object_report_sort_job: [], custom_object_report_sort_row: [] };
  const calls = [], commits = [];
  class Query {
    constructor(table) { this.table = table; this.filters = []; this.limitBy = Infinity; }
    select() { return this; }
    eq(k, v) { this.filters.push(r => r[k] === v); return this; }
    is(k, v) { return this.eq(k, v); }
    gte(k, v) { this.filters.push(r => r[k] >= v); return this; }
    lt(k, v) { this.filters.push(r => r[k] < v); return this; }
    order(k) { this.orderBy = k; return this; }
    limit(n) { this.limitBy = n; return this; }
    insert(value) { this.inserted = value; return this; }
    update(value) { this.updated = value; return this; }
    maybeSingle() { this.singleRow = true; return this; }
    single() { this.singleRow = true; return this; }
    then(resolve, reject) {
      try {
        if (this.inserted) tables[this.table].push({
          id: 'job', processed: 0, total: 0, next_page: 1, chunk_size: 200, cursor_value: null,
          claim_token: null, ...this.inserted,
        });
        let rows = tables[this.table].filter(r => this.filters.every(f => f(r)));
        if (this.updated) rows.forEach(r => Object.assign(r, this.updated));
        if (this.orderBy) rows = [...rows].sort((a, b) => a[this.orderBy] - b[this.orderBy]);
        rows = rows.slice(0, this.limitBy).map(r => structuredClone(r));
        resolve({ data: this.singleRow ? rows[0] || null : rows, error: null });
      } catch (error) { reject(error); }
    }
  }
  const db = { from(table) { calls.push(table); return new Query(table); },
    async rpc(name, args) {
      if (name === 'custom_object_report_sort_prune') return { data: 0 };
      if (name === 'custom_object_report_viewer_page') {
        const rows = tables.custom_object_report_sort_row.filter(row => row.tenant_id === args.p_tenant_id
          && row.job_id === args.p_job_id && matchesReportViewerQuery(row.row_values, args.p_query))
          .sort((a, b) => a.position - b.position);
        return { data: { total: rows.length, data: rows.slice(args.p_offset, args.p_offset + args.p_limit)
          .map(row => ({ id: row.row_identity, values: row.row_values })) } };
      }
      commits.push({ name, args });
      const job = tables.custom_object_report_sort_job[0];
      args.p_rows.forEach((r, i) => tables.custom_object_report_sort_row.push({
        tenant_id: 'tenant', job_id: job.id, row_identity: r.id, row_values: r.values, position: i + 1,
      }));
      Object.assign(job, { status: 'ready', processed: args.p_rows.length, headers: args.p_headers, claim_token: null });
      return { data: structuredClone(job) };
    } };
  let revoked = false;
  const executeCalls = [];
  const service = createReportSortService({ db, tenantId: 'tenant', context: { memberId: 'member' },
    now: () => new Date().toISOString(), ErrorType: HttpError,
    async validate(_, supplied) { if (revoked) throw new HttpError(403, 'Field unavailable');
      return { report: supplied, grain: { hops: [] } }; },
    async execute(...args) { executeCalls.push(args); return { bounded: true, columns: [{ label: 'Amount' }],
      data: [{ id: 'r1', values: ['10'], sort_values: [10] }], total: 1, has_more: false, next_cursor: 'r1' }; },
    ...changes,
  });
  return { tables, service, commits, executeCalls, calls, db, revoke() { revoked = true; } };
}
test('viewer search filters the full snapshot before pagination and validates exposed columns', async () => {
  const f = fixture({ context: { reportGrantId: 'grant' } });
  await f.service.preview('object', { definition });
  const job = f.tables.custom_object_report_sort_job[0];
  Object.assign(job, { status: 'ready', processed: 1003, headers: ['Amount'] });
  for (let n = 1; n <= 1003; n++) f.tables.custom_object_report_sort_row.push({
    tenant_id: 'tenant', job_id: job.id, row_identity: `r${n}`, row_values: [String(n)], position: n,
  });
  const viewer_query = { search: '100', filters: [] };
  const result = await f.service.preview('object', { action: 'page', job_id: job.id, pageSize: 2, viewer_query });
  assert.equal(result.total, 5); // 100, 1000, 1001, 1002, 1003
  assert.deepEqual(result.data.map(row => row.values[0]), ['100', '1000']);
  assert.equal(result.has_more, true);
  const next = await f.service.preview('object', { action: 'page', job_id: job.id, pageSize: 2, page: 3, viewer_query });
  assert.deepEqual(next.data.map(row => row.values[0]), ['1003']);
  assert.equal(next.has_more, false);
  const none = await f.service.preview('object', { action: 'page', job_id: job.id, viewer_query: { search: 'absent' } });
  assert.equal(none.total, 0);
  assert.deepEqual(none.data, []);
  await assert.rejects(f.service.preview('object', { action: 'page', job_id: job.id,
    viewer_query: { filters: [{ column: 1, operator: 'empty' }] } }), error => error.status === 400);
  f.revoke();
  await assert.rejects(f.service.preview('object', { action: 'page', job_id: job.id, viewer_query }), /unavailable/);
});

test('filtered CSV pins criteria at start and filters source pages without changing saved definitions', async () => {
  const f = fixture({ context: { reportGrantId: 'grant' }, async execute() {
    return { bounded: true, columns: [{ label: 'Amount' }], data: [
      { id: 'r1', values: ['10'], sort_values: [10] }, { id: 'r2', values: ['20'], sort_values: [20] },
    ], has_more: false };
  } });
  const viewer_query = { search: '20', filters: [] };
  const job = await f.service.export('object', { definition, viewer_query });
  assert.deepEqual(job.definition, definition);
  assert.deepEqual(f.tables.custom_object_report_sort_job[0].viewer_query, viewer_query);
  const ready = await f.service.export('object', { action: 'process', job_id: job.id, viewer_query: { search: '10' } });
  assert.equal(ready.processed, 1);
  const chunk = await f.service.export('object', { action: 'chunk', job_id: job.id, chunk_index: 0 });
  assert.match(chunk.csv_text, /20/);
  assert.doesNotMatch(chunk.csv_text, /10/);
});
test('sorted preview freezes a definition, prepares bounded pages and reads an immutable result', async () => {
  const f = fixture();
  const first = await f.service.preview('object', { definition });
  assert.equal(first.sort_job.status, 'queued');
  const ready = await f.service.preview('object', { definition, action: 'process', job_id: 'job' });
  assert.deepEqual(ready.data, [{ id: 'r1', values: ['10'] }]);
  assert.equal(ready.sort_job.status, 'complete');
  assert.equal(f.executeCalls[0][2].pageSize, 200);
  assert.equal(f.executeCalls[0][2].sortMaterialization, true);
  assert.equal(f.commits[0].args.p_rows[0].sort_values[0], 10);
  const again = await f.service.preview('object', { definition, action: 'page', job_id: 'job' });
  assert.deepEqual(again.data, ready.data);
  assert.equal(f.executeCalls.length, 1);
  await assert.rejects(f.service.preview('object', { definition: { ...definition, sort: [] }, action: 'page', job_id: 'job' }), /definition changed/);
  f.revoke();
  await assert.rejects(f.service.preview('object', { definition, action: 'page', job_id: 'job' }), /unavailable/);
});
test('sorted snapshots enforce tenant, object, actor, mode and expiry boundaries', async () => {
  const f = fixture();
  await f.service.preview('object', { definition });
  await assert.rejects(f.service.export('object', { action: 'status', job_id: 'job' }), /not found/);
  await assert.rejects(f.service.preview('other', { definition, action: 'page', job_id: 'job' }), /not found/);
  const job = f.tables.custom_object_report_sort_job[0];
  job.requested_by_member_id = 'other';
  await assert.rejects(f.service.preview('object', { definition, action: 'page', job_id: 'job' }), /not found/);
  job.requested_by_member_id = 'member'; job.tenant_id = 'foreign';
  await assert.rejects(f.service.preview('object', { definition, action: 'page', job_id: 'job' }), /not found/);
  job.tenant_id = 'tenant'; job.expires_at = '2000-01-01';
  await assert.rejects(f.service.preview('object', { definition, action: 'page', job_id: 'job' }), /expired/);
});
test('exports stream ranked chunks, enforce readiness and reject incomplete snapshot reads', async () => {
  const f = fixture();
  await f.service.export('object', { definition });
  await assert.rejects(f.service.export('object', { action: 'chunk', job_id: 'job', chunk_index: 0 }), /not ready/);
  await f.service.export('object', { action: 'process', job_id: 'job' });
  const chunk = await f.service.export('object', { action: 'chunk', job_id: 'job', chunk_index: 0 });
  assert.match(chunk.csv_text, /Amount\r?\n10/);
  await assert.rejects(f.service.export('object', { action: 'chunk', job_id: 'job', chunk_index: -1 }), /Invalid/);
  f.tables.custom_object_report_sort_row.length = 0;
  await assert.rejects(f.service.export('object', { action: 'chunk', job_id: 'job', chunk_index: 0 }), /incomplete/);
});
test('invalid sort definitions and stalled cursors fail explicitly without unsorted fallback', async () => {
  const f = fixture({ async execute() { return { bounded: true, data: [], has_more: true, next_cursor: null }; } });
  await assert.rejects(f.service.preview('object', { definition: { ...definition, sort: [] } }), /at least one/);
  await f.service.preview('object', { definition });
  await assert.rejects(f.service.preview('object', { definition, action: 'process', job_id: 'job' }), /did not advance/);
  assert.equal(f.tables.custom_object_report_sort_job[0].status, 'failed');
  assert.equal(f.commits.length, 0);
});
