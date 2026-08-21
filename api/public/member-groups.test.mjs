import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PUBLIC_SELECTED_GROUP_SELECT,
  PUBLIC_SELF_JOIN_GROUP_SELECT,
  handlePublicMemberGroups,
  parseRequestedGroupIds,
} from './member-groups.js';

class FakeQuery {
  constructor(rows) {
    this.rows = rows;
    this.filters = [];
    this.selectValue = '';
    this.inValues = null;
    this.orders = [];
  }

  select(value) { this.selectValue = value; return this; }
  eq(column, value) { this.filters.push((row) => row[column] === value); return this; }
  neq(column, value) { this.filters.push((row) => row[column] != null && row[column] !== value); return this; }
  in(column, values) {
    this.inValues = { column, values: [...values] };
    const allowed = new Set(values);
    this.filters.push((row) => allowed.has(row[column]));
    return this;
  }
  order(column) { this.orders.push(column); return this; }
  then(resolve, reject) {
    let data = this.rows.filter((row) => this.filters.every((filter) => filter(row)));
    if (this.orders.includes('name')) data = [...data].sort((a, b) => a.name.localeCompare(b.name));
    const columns = this.selectValue
      .split(',')
      .map((column) => column.trim())
      .filter(Boolean);
    data = data.map((row) => Object.fromEntries(columns.map((column) => [column, row[column]])));
    return Promise.resolve({ data, error: null }).then(resolve, reject);
  }
}

function response() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function fakeSupabase(rows) {
  const query = new FakeQuery(rows);
  return { query, from: () => query };
}

const groups = [
  { id: 'other', tenant_id: 'tenant-2', name: 'Other tenant', is_active: true, allow_self_join: false },
  { id: 'inactive', tenant_id: 'tenant-1', name: 'Inactive', is_active: false, allow_self_join: false },
  { id: 'managed', tenant_id: 'tenant-1', name: 'Managed', is_active: true, allow_self_join: false, automatic_membership_enabled: true },
  { id: 'self-join', tenant_id: 'tenant-1', name: 'Alpha', is_active: true, allow_self_join: true },
];

test('explicit selected group ids are de-duplicated and bounded', () => {
  assert.deepEqual(parseRequestedGroupIds('a, b,a,,c'), ['a', 'b', 'c']);
  assert.equal(parseRequestedGroupIds(Array.from({ length: 25 }, (_, index) => `group-${index}`)).length, 24);
});

test('legacy request keeps the self-join query and presentation fields', async () => {
  const supabase = fakeSupabase(groups);
  const res = response();
  await handlePublicMemberGroups({ query: {} }, res, { supabase, tenant: { id: 'tenant-1' } });
  assert.deepEqual(res.body.map((group) => group.id), ['self-join']);
  assert.match(supabase.query.selectValue, /who_is_it_for/);
  assert.equal(supabase.query.inValues, null);
});

test('selected request permits active managed groups but filters inactive and cross-tenant rows', async () => {
  const supabase = fakeSupabase(groups);
  const res = response();
  await handlePublicMemberGroups(
    { query: { groupIds: 'other,managed,inactive' } },
    res,
    { supabase, tenant: { id: 'tenant-1' } },
  );
  assert.deepEqual(res.body.map((group) => group.id), ['managed']);
  assert.deepEqual(
    Object.keys(res.body[0]).sort(),
    PUBLIC_SELECTED_GROUP_SELECT.split(',').map((column) => column.trim()).filter(Boolean).sort(),
  );
  assert.equal('automatic_membership_enabled' in res.body[0], false);
  assert.equal('default_self_join_role' in res.body[0], false);
  assert.deepEqual(supabase.query.inValues, {
    column: 'id',
    values: ['other', 'managed', 'inactive'],
  });
  assert.match(supabase.query.selectValue, /header_image_url/);
  assert.ok(!PUBLIC_SELECTED_GROUP_SELECT.includes('automatic_membership'));
  assert.ok(!PUBLIC_SELECTED_GROUP_SELECT.includes('default_self_join_role'));
  assert.ok(!PUBLIC_SELECTED_GROUP_SELECT.includes('who_is_it_for'));
  assert.ok(PUBLIC_SELF_JOIN_GROUP_SELECT.includes('who_is_it_for'));
});