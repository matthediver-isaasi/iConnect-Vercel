import test from 'node:test';
import assert from 'node:assert/strict';
import { applyVoucherMemberSearch } from './voucher-members.js';

test('admin member search scopes tenant before literal quoted OR and limits results', () => {
  const calls = [];
  const query = {};
  for (const method of ['from', 'select', 'eq', 'or', 'order', 'limit']) {
    query[method] = (...args) => { calls.push([method, ...args]); return query; };
  }
  applyVoucherMemberSearch(query, 'tenant-a', 'a"\\%,(x)_');
  assert.deepEqual(calls.find(call => call[0] === 'eq'), ['eq', 'tenant_id', 'tenant-a']);
  const expression = calls.find(call => call[0] === 'or')[1];
  const quoted = expression.slice('first_name.ilike.'.length, expression.indexOf(',last_name.ilike.'));
  assert.equal(JSON.parse(quoted), '%a"\\\\\\%,(x)\\_%');
  assert.deepEqual(calls.at(-1), ['limit', 50]);
});
