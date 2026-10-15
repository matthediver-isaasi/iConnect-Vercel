import test from 'node:test';
import assert from 'node:assert/strict';
import { processImportSlice } from './importProcessor.js';

// In-memory client: no network, credentials or organisation records are used.
async function importRow({ name, mapped = true, clearOnEmpty = false }) {
  const row = { id: 'org-fixture', name: 'Existing Hospital', address: 'Old address' };
  const writes = [];
  const db = {
    from(table) {
      assert.equal(table, 'organization');
      let payload;
      const query = {
        select() { return this; }, eq() { return this; }, in() { return this; },
        update(value) { payload = value; return this; },
        then(resolve, reject) {
          if (payload) { writes.push(payload); Object.assign(row, payload); }
          return Promise.resolve({ data: [row], error: null }).then(resolve, reject);
        },
      };
      return query;
    },
    rpc() { throw new Error('ID-based updates must not use the name-matching RPC'); },
  };
  const result = await processImportSlice({
    supabase: db, records: [{ ID: row.id, Name: name, Address: 'New address' }],
    mappings: [
      { sourceColumn: 'ID', targetField: 'id' },
      { sourceColumn: 'Address', targetField: 'address' },
      ...(mapped ? [{ sourceColumn: 'Name', targetField: 'name', clearOnEmpty }] : []),
    ],
    entityType: 'organization', identifierField: 'id', tenantId: 'tenant-fixture',
  });
  return { row, writes, result };
}

test('address-only import preserves populated name when name is omitted or a blank cell is ignored', async () => {
  for (const args of [{ mapped: false }, { name: undefined }, { name: '' }, { name: ' \t' }]) {
    const { row, writes, result } = await importRow(args);
    assert.equal(result.updated, 1);
    assert.equal(row.name, 'Existing Hospital');
    assert.equal(row.address, 'New address');
    assert.equal(Object.hasOwn(writes[0], 'name'), false);
  }
});

test('explicit null and clear-on-empty name imports reject the whole row', async () => {
  for (const args of [{ name: null }, { name: '', clearOnEmpty: true }, { name: ' \t', clearOnEmpty: true }]) {
    const { row, writes, result } = await importRow(args);
    assert.equal(result.errors, 1);
    assert.match(result.errorLog[0].error, /Organisation name is required/);
    assert.deepEqual(writes, []);
    assert.equal(row.name, 'Existing Hospital');
    assert.equal(row.address, 'Old address');
  }
});

test('nonblank import may rename an organisation', async () => {
  const { row, result } = await importRow({ name: ' Renamed Hospital ' });
  assert.equal(result.updated, 1);
  assert.equal(row.name, 'Renamed Hospital');
});
