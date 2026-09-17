import test from 'node:test';
import assert from 'node:assert/strict';
import { getOnlyFetch, readPages } from './workforce-readonly-state.mjs';

const DESTINATION = 'https://lvmzliemqnieeoruhkik.supabase.co';

function rows(count, prefix = 'row') {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${String(index).padStart(4, '0')}`,
  }));
}

function fixtureDb({
  sourceRows = [],
  count = sourceRows.length,
  serverPageSize = 500,
  responses = new Map(),
} = {}) {
  const calls = [];
  const db = {
    calls,
    from(table) {
      const query = {
        select() { return this; },
        order() { return this; },
        eq() { return this; },
        in() { return this; },
        or() { return this; },
        range(from, to) {
          calls.push({ table, from, to });
          this.offset = from;
          this.end = to;
          return this;
        },
        then(resolve, reject) {
          const configured = responses.get(this.offset);
          if (configured) return Promise.resolve(configured).then(resolve, reject);
          const data = sourceRows.slice(
            this.offset,
            Math.min(this.end + 1, this.offset + serverPageSize),
          );
          const exactCount = typeof count === 'function' ? count(this.offset) : count;
          return Promise.resolve({ data, error: null, count: exactCount }).then(resolve, reject);
        },
      };
      return query;
    },
  };
  return db;
}

test('getOnlyFetch rejects every non-GET method without calling the transport', () => {
  const calls = [];
  const onlyFetch = getOnlyFetch(async (...args) => {
    calls.push(args);
    return { ok: true };
  });

  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']) {
    assert.throws(
      () => onlyFetch(`${DESTINATION}/rest/v1/tenant`, { method }),
      /Read-only audit allows only destination table GET requests/,
    );
  }
  assert.equal(calls.length, 0);
});

test('getOnlyFetch rejects RPC paths, other hosts, and redirects even for GET', async () => {
  const calls = [];
  const onlyFetch = getOnlyFetch(async (...args) => {
    calls.push(args);
    return { ok: true };
  });

  assert.throws(
    () => onlyFetch(`${DESTINATION}/rest/v1/rpc/read_something`, { method: 'GET' }),
    /Read-only audit allows only destination table GET requests/,
  );
  assert.throws(
    () => onlyFetch('https://another-project.supabase.co/rest/v1/tenant', { method: 'GET' }),
    /Read-only audit allows only destination table GET requests/,
  );

  await onlyFetch(`${DESTINATION}/rest/v1/tenant`, { method: 'GET', redirect: 'follow' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1].redirect, 'error');
  assert.ok(calls[0][1].signal instanceof AbortSignal);
});

test('readPages follows offsets when the server has a lower page cap than requested', async () => {
  const fixture = fixtureDb({ sourceRows: rows(1205), serverPageSize: 137 });
  const ledger = [];
  const result = await readPages(
    fixture,
    'custom_object_record',
    'id',
    (query) => query.eq('tenant_id', 'tenant'),
    ledger,
  );

  assert.equal(result.length, 1205);
  assert.deepEqual(result, rows(1205));
  assert.deepEqual(fixture.calls.map(({ from, to }) => [from, to]), [
    [0, 499], [137, 636], [274, 773], [411, 910], [548, 1047],
    [685, 1184], [822, 1321], [959, 1458], [1096, 1595],
  ]);
  assert.deepEqual(ledger, [{
    label: 'custom_object_record',
    table: 'custom_object_record',
    count: 1205,
    rowsRead: 1205,
    requests: 9,
    pageSize: 500,
    complete: true,
  }]);
});

test('readPages requires an exact non-negative count', async () => {
  for (const count of [null, 1.5, -1, Number.MAX_SAFE_INTEGER + 1]) {
    const fixture = fixtureDb({ sourceRows: [], count });
    await assert.rejects(
      readPages(fixture, 'tenant', '*', (query) => query, []),
      /did not return rows and an exact count/,
    );
  }
  const undefinedCount = fixtureDb({
    responses: new Map([[0, { data: [], error: null, count: undefined }]]),
  });
  await assert.rejects(
    readPages(undefinedCount, 'tenant', '*', (query) => query, []),
    /did not return rows and an exact count/,
  );
});

test('readPages rejects repeated or missing IDs', async () => {
  const duplicate = fixtureDb({
    sourceRows: [{ id: 'same' }, { id: 'same' }],
  });
  await assert.rejects(
    readPages(duplicate, 'tenant', '*', (query) => query, []),
    /repeated or missing record ID/,
  );

  const missing = fixtureDb({
    sourceRows: [{ id: 'present' }, { value: 'no-id' }],
  });
  await assert.rejects(
    readPages(missing, 'tenant', '*', (query) => query, []),
    /repeated or missing record ID/,
  );
});

test('readPages rejects truncation after a short or empty page', async () => {
  const truncated = fixtureDb({
    sourceRows: rows(1000),
    count: 1001,
  });
  await assert.rejects(
    readPages(truncated, 'tenant', '*', (query) => query, []),
    /pagination incomplete/,
  );

  const emptyMiddlePage = fixtureDb({
    sourceRows: rows(1001),
    responses: new Map([[500, { data: [], error: null, count: 1001 }]]),
  });
  await assert.rejects(
    readPages(emptyMiddlePage, 'tenant', '*', (query) => query, []),
    /pagination incomplete/,
  );
});

test('readPages rejects count drift between pages', async () => {
  const fixture = fixtureDb({
    sourceRows: rows(501),
    count: (from) => (from === 0 ? 501 : 502),
  });
  await assert.rejects(
    readPages(fixture, 'tenant', '*', (query) => query, []),
    /changed during pagination/,
  );
});

test('readPages rejects transport errors and disallowed tables', async () => {
  const errorFixture = fixtureDb({
    responses: new Map([[0, { data: null, error: { code: '42501' }, count: 0 }]]),
  });
  await assert.rejects(
    readPages(errorFixture, 'tenant', '*', (query) => query, []),
    /tenant read failed \(42501\)/,
  );
  await assert.rejects(
    readPages(fixtureDb(), 'not_a_table', '*', (query) => query, []),
    /Table not permitted/,
  );
});