import assert from 'node:assert/strict';
import test from 'node:test';
import {
  matchesOrganisationDirectoryFilter,
  OrganisationDirectoryFilterError,
  saveOrganisationDirectoryFilterOverrides,
} from './organisationDirectoryFilters.js';

test('stored empty numeric values never match zero or zero-inclusive comparisons', () => {
  for (const field_type of ['number', 'integer', 'decimal', 'currency']) {
    for (const filter of [
      { operator: 'eq', value: 0 },
      { operator: 'between', value: [-1, 1] },
      { operator: 'gte', value: 0 },
      { operator: 'lte', value: 0 },
    ]) {
      for (const value of ['', '   ', '\t\n', null, undefined, false, true, Infinity, 'Infinity', 'invalid']) {
        assert.equal(matchesOrganisationDirectoryFilter([value], filter, { field_type }), false,
          `${field_type} ${filter.operator}: ${JSON.stringify(value)} is not numeric zero`);
      }
      for (const value of [0, '0', ' 0 ']) {
        assert.equal(matchesOrganisationDirectoryFilter([value], filter, { field_type }), true);
      }
    }
  }
});

test('filter matching supports AND-building primitives and choice OR values', () => {
  const choice = { field_type: 'select' };
  assert.equal(matchesOrganisationDirectoryFilter(['alpha'], {
    operator: 'eq', value: ['beta', 'alpha'],
  }, choice), true);
  assert.equal(matchesOrganisationDirectoryFilter(['Alpha Beta'], {
    operator: 'contains', value: 'beta',
  }, choice), true);
  assert.equal(matchesOrganisationDirectoryFilter([10], {
    operator: 'between', value: [9, 11],
  }, { field_type: 'number' }), true);
  assert.equal(matchesOrganisationDirectoryFilter(['2026-02-01'], {
    operator: 'gte', value: '2026-01-01',
  }, { field_type: 'date' }), true);
  assert.equal(matchesOrganisationDirectoryFilter([], {
    operator: 'absent',
  }, { field_type: 'file' }), true);
  assert.equal(matchesOrganisationDirectoryFilter([false, 0], {
    operator: 'present',
  }, { field_type: 'text' }), true);
});

function settingsDb(initialValue = undefined) {
  let isCalls = 0;
  const rows = initialValue === undefined ? [] : [{
    id: 'setting-1',
    tenant_id: 'tenant-1',
    setting_key: 'org_directory_filterable_back_fields',
    setting_value: initialValue,
  }];
  class Query {
    constructor(action = 'read', value = null) {
      this.action = action;
      this.value = value;
      this.filters = [];
    }
    select() { return this; }
    eq(column, value) { this.filters.push([column, value]); return this; }
    is(column, value) { isCalls += 1; this.filters.push([column, value]); return this; }
    limit() { return this; }
    then(resolve, reject) {
      let data = rows.filter((row) => this.filters.every(([key, value]) => row[key] === value));
      if (this.action === 'update') {
        for (const row of data) Object.assign(row, this.value);
        data = data.map(({ id }) => ({ id }));
      }
      if (this.action === 'insert') {
        const row = { id: 'setting-1', ...this.value };
        rows.push(row);
        data = [{ id: row.id }];
      }
      return Promise.resolve({ data: structuredClone(data), error: null }).then(resolve, reject);
    }
  }
  return {
    rows,
    get isCalls() { return isCalls; },
    from() {
      const query = new Query();
      query.update = (value) => new Query('update', value);
      query.insert = (value) => new Query('insert', value);
      return query;
    },
  };
}

test('settings merge preserves unknown entries and validates writable changes', async () => {
  const db = settingsDb('{"custom:known":false,"future:key":true}');
  const result = await saveOrganisationDirectoryFilterOverrides({
    db,
    tenantId: 'tenant-1',
    changes: { 'custom:known': true },
    writableKeys: new Set(['custom:known']),
  });
  assert.deepEqual(result, { 'custom:known': true, 'future:key': true });
  assert.deepEqual(JSON.parse(db.rows[0].setting_value), result);
  await assert.rejects(() => saveOrganisationDirectoryFilterOverrides({
    db,
    tenantId: 'tenant-1',
    changes: { forged: true },
    writableKeys: new Set(['custom:known']),
  }), (error) => error instanceof OrganisationDirectoryFilterError && error.status === 400);
});

test('settings update rejects malformed persisted maps', async () => {
  await assert.rejects(() => saveOrganisationDirectoryFilterOverrides({
    db: settingsDb('{"custom:known":"true"}'),
    tenantId: 'tenant-1',
    changes: { 'custom:known': true },
    writableKeys: new Set(['custom:known']),
  }), (error) => error.status === 500);
});

test('null setting values use a null CAS and historical duplicate keys fail explicitly', async () => {
  const nullDb = settingsDb(null);
  assert.deepEqual(await saveOrganisationDirectoryFilterOverrides({
    db: nullDb,
    tenantId: 'tenant-1',
    changes: { 'custom:known': true },
    writableKeys: new Set(['custom:known']),
  }), { 'custom:known': true });
  assert.equal(nullDb.isCalls, 1);

  const duplicateDb = settingsDb('{}');
  duplicateDb.rows.push({
    id: 'setting-2',
    tenant_id: 'tenant-1',
    setting_key: 'org_directory_filterable_back_fields',
    setting_value: '{}',
  });
  await assert.rejects(() => saveOrganisationDirectoryFilterOverrides({
    db: duplicateDb,
    tenantId: 'tenant-1',
    changes: { 'custom:known': true },
    writableKeys: new Set(['custom:known']),
  }), (error) => error.status === 409 && /Multiple/.test(error.message));
});

function concurrentFirstInsertDb({ insertError = null } = {}) {
  const rows = [];
  let emptyReads = 0;
  let releaseReads;
  const readBarrier = new Promise((resolve) => { releaseReads = resolve; });
  class Query {
    constructor(action = 'read', value = null) {
      this.action = action;
      this.value = value;
      this.filters = [];
    }
    select() { return this; }
    limit() { return this; }
    eq(column, value) { this.filters.push([column, value]); return this; }
    is(column, value) { this.filters.push([column, value]); return this; }
    async execute() {
      if (this.action === 'read') {
        const snapshot = rows.filter((row) =>
          this.filters.every(([key, value]) => row[key] === value));
        if (!snapshot.length && emptyReads < 2) {
          emptyReads += 1;
          if (emptyReads === 2) releaseReads();
          await readBarrier;
        }
        return { data: structuredClone(snapshot), error: null };
      }
      if (this.action === 'insert') {
        if (insertError) return { data: null, error: insertError };
        if (rows.some((row) => row.id === this.value.id)) {
          return { data: null, error: { code: '23505', message: 'duplicate primary key' } };
        }
        rows.push(structuredClone(this.value));
        return { data: [{ id: this.value.id }], error: null };
      }
      const matches = rows.filter((row) =>
        this.filters.every(([key, value]) => row[key] === value));
      for (const row of matches) Object.assign(row, this.value);
      return { data: matches.map(({ id }) => ({ id })), error: null };
    }
    then(resolve, reject) { return this.execute().then(resolve, reject); }
  }
  return {
    rows,
    from() {
      const query = new Query();
      query.insert = (value) => new Query('insert', value);
      query.update = (value) => new Query('update', value);
      return query;
    },
  };
}

test('deterministic first insert key serializes concurrent saves without losing either change', async () => {
  const db = concurrentFirstInsertDb();
  await Promise.all([
    saveOrganisationDirectoryFilterOverrides({
      db,
      tenantId: 'tenant-1',
      changes: { 'custom:a': true },
      writableKeys: new Set(['custom:a']),
    }),
    saveOrganisationDirectoryFilterOverrides({
      db,
      tenantId: 'tenant-1',
      changes: { 'custom:b': false },
      writableKeys: new Set(['custom:b']),
    }),
  ]);
  assert.equal(db.rows.length, 1);
  assert.deepEqual(JSON.parse(db.rows[0].setting_value), {
    'custom:a': true,
    'custom:b': false,
  });
});

test('first insert retries only primary-key conflicts and surfaces other database failures', async () => {
  const db = concurrentFirstInsertDb({
    insertError: { code: '42501', message: 'insert forbidden' },
  });
  // Release the initial-read barrier with a second operation.
  await assert.rejects(() => Promise.all([
    saveOrganisationDirectoryFilterOverrides({
      db,
      tenantId: 'tenant-1',
      changes: { 'custom:a': true },
      writableKeys: new Set(['custom:a']),
    }),
    saveOrganisationDirectoryFilterOverrides({
      db,
      tenantId: 'tenant-1',
      changes: { 'custom:b': true },
      writableKeys: new Set(['custom:b']),
    }),
  ]), /insert forbidden/);

  const unrelatedUniqueFailure = concurrentFirstInsertDb({
    insertError: { code: '23505', message: 'unrelated unique constraint' },
  });
  await assert.rejects(() => Promise.all([
    saveOrganisationDirectoryFilterOverrides({
      db: unrelatedUniqueFailure,
      tenantId: 'tenant-1',
      changes: { 'custom:a': true },
      writableKeys: new Set(['custom:a']),
    }),
    saveOrganisationDirectoryFilterOverrides({
      db: unrelatedUniqueFailure,
      tenantId: 'tenant-1',
      changes: { 'custom:b': true },
      writableKeys: new Set(['custom:b']),
    }),
  ]), /unrelated unique constraint/);
});