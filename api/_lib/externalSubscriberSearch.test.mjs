import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyExternalSubscriberFilters,
  countExternalSubscribersByCategory,
  listExternalSubscribers,
  normalizeExternalSubscriberSearch,
} from './externalSubscriberSearch.js';

class Query {
  constructor(result) {
    this.result = result;
    this.operations = [];
  }
  select(...args) {
    this.operations.push(['select', ...args]);
    return this;
  }
  eq(...args) {
    this.operations.push(['eq', ...args]);
    return this;
  }
  or(...args) {
    this.operations.push(['or', ...args]);
    return this;
  }
  order(...args) {
    this.operations.push(['order', ...args]);
    return this;
  }
  range(...args) {
    this.operations.push(['range', ...args]);
    return this;
  }
  then(resolve, reject) {
    return Promise.resolve(this.result).then(resolve, reject);
  }
}

test('external search normalization removes PostgREST control syntax and bounds input', () => {
  assert.equal(normalizeExternalSubscriberSearch('  Ada, (Lovelace)%  '), 'Ada Lovelace');
  assert.equal(normalizeExternalSubscriberSearch('x'.repeat(150)).length, 100);
});

test('external search applies tenant, category, active, and case-insensitive name/email filters', () => {
  const query = new Query({});
  applyExternalSubscriberFilters(query, {
    tenantId: 'tenant-1',
    categoryId: 'category-1',
    search: 'ADA Lovelace',
  });

  assert.deepEqual(query.operations.slice(0, 3), [
    ['eq', 'tenant_id', 'tenant-1'],
    ['eq', 'communication_category_id', 'category-1'],
    ['eq', 'opted_out', false],
  ]);
  assert.deepEqual(query.operations.slice(3), [
    ['or', 'first_name.ilike.%ADA%,last_name.ilike.%ADA%,email.ilike.%ADA%'],
    ['or', 'first_name.ilike.%Lovelace%,last_name.ilike.%Lovelace%,email.ilike.%Lovelace%'],
  ]);
});

test('result page and exact count use identical complete-dataset filters before paging', async () => {
  const queries = [
    new Query({ data: [{ id: 'subscriber-1' }], error: null }),
    new Query({ count: 11, error: null }),
  ];
  const database = {
    from(table) {
      assert.equal(table, 'email_subscriber');
      return queries.shift();
    },
  };

  const resultQueries = [...queries];
  const result = await listExternalSubscribers({
    database,
    tenantId: 'tenant-1',
    categoryId: 'category-1',
    search: 'ada',
    page: 2,
    perPage: 10,
  });

  assert.deepEqual(result, {
    subscribers: [{ id: 'subscriber-1' }],
    total: 11,
    page: 2,
    per_page: 10,
  });

  const sharedFilters = (query) =>
    query.operations.filter(([operation]) => operation === 'eq' || operation === 'or');
  assert.deepEqual(sharedFilters(resultQueries[0]), sharedFilters(resultQueries[1]));
  assert.deepEqual(
    resultQueries[0].operations.find(([operation]) => operation === 'range'),
    ['range', 10, 19]
  );
  assert.equal(
    resultQueries[1].operations.some(([operation]) => operation === 'range'),
    false
  );
});

test('either result or count failure rejects the list request', async () => {
  const error = new Error('count failed');
  const queries = [
    new Query({ data: [], error: null }),
    new Query({ count: null, error }),
  ];
  await assert.rejects(
    listExternalSubscribers({
      database: { from: () => queries.shift() },
      tenantId: 'tenant-1',
      categoryId: 'category-1',
      search: '',
      page: 1,
      perPage: 10,
    }),
    error
  );
});

test('category counts page through every active subscriber with stable ordering', async () => {
  const queries = [
    new Query({
      data: [
        { id: '1', communication_category_id: 'category-1' },
        { id: '2', communication_category_id: 'category-2' },
      ],
      error: null,
    }),
    new Query({
      data: [
        { id: '3', communication_category_id: 'category-1' },
        { id: '4', communication_category_id: null },
      ],
      error: null,
    }),
    new Query({
      data: [{ id: '5', communication_category_id: 'category-2' }],
      error: null,
    }),
  ];
  const allQueries = [...queries];

  const counts = await countExternalSubscribersByCategory({
    database: { from: () => queries.shift() },
    tenantId: 'tenant-1',
    pageSize: 2,
  });

  assert.deepEqual(counts, {
    'category-1': 2,
    'category-2': 2,
  });
  assert.deepEqual(
    allQueries.map(query => query.operations.find(([operation]) => operation === 'range')),
    [
      ['range', 0, 1],
      ['range', 2, 3],
      ['range', 4, 5],
    ]
  );
  for (const query of allQueries) {
    assert.deepEqual(
      query.operations.find(([operation]) => operation === 'order'),
      ['order', 'id', { ascending: true }]
    );
    assert.deepEqual(
      query.operations.filter(([operation]) => operation === 'eq'),
      [
        ['eq', 'tenant_id', 'tenant-1'],
        ['eq', 'opted_out', false],
      ]
    );
  }
});

test('category count query errors reject instead of returning zero counts', async () => {
  const error = new Error('page failed');

  await assert.rejects(
    countExternalSubscribersByCategory({
      database: { from: () => new Query({ data: null, error }) },
      tenantId: 'tenant-1',
    }),
    error
  );
});
