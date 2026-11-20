import test from 'node:test';
import assert from 'node:assert/strict';
import { createReportSortService } from './customObjectReportSort.js';

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
  return { tables, service, commits, executeCalls, calls, revoke() { revoked = true; } };
}
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
