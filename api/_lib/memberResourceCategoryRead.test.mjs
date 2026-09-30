import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MEMBER_RESOURCE_CATEGORY_SELECT, scopeMemberResourceCategoryRead } from './memberResourceCategoryRead.js';

const rows = [
  { id: 'answer-own', member_id: 'self', tenant: 'tenant-a', resource_category_id: 'category-a', subcategory_name: 'Research' },
  { id: 'answer-peer', member_id: 'peer', tenant: 'tenant-a' },
  { id: 'answer-foreign', member_id: 'foreign', tenant: 'tenant-b' },
];
const member = { isAuthenticated: true, tenantId: 'tenant-a', memberId: 'self' };

function queryFixture() {
  const filters = [];
  return {
    eq(column, value) { filters.push([column, value]); return this; },
    data() {
      return rows.filter(row => filters.every(([column, value]) =>
        (column === 'category_owner.tenant_id' ? row.tenant : row[column]) === value));
    },
    filters,
  };
}

test('own-member prefill returns saved category and subcategory answers', () => {
  const result = scopeMemberResourceCategoryRead(queryFixture(), member, false);
  result.query.eq('member_id', 'self');
  assert.deepEqual(result.query.data(), [rows[0]]);
  assert.equal(result.query.data()[0].subcategory_name, 'Research');
  assert.ok(!result.query.filters.some(([key]) => key === 'tenant_id'));
});

test('regular members cannot select another member, even in the same tenant', () => {
  for (const id of ['peer', 'foreign']) {
    const { query } = scopeMemberResourceCategoryRead(queryFixture(), member, false);
    query.eq('member_id', id);
    assert.deepEqual(query.data(), []);
  }
});

test('authorized tenant admin can preview another member in the tenant', () => {
  const { query } = scopeMemberResourceCategoryRead(queryFixture(),
    { ...member, memberId: null, tenantUserId: 'admin' }, true);
  query.eq('member_id', 'peer');
  assert.deepEqual(query.data(), [rows[1]]);
});

test('tenant admins cannot read cross-tenant selections by member or row ID', () => {
  for (const [column, value] of [['member_id', 'foreign'], ['id', 'answer-foreign']]) {
    const { query } = scopeMemberResourceCategoryRead(queryFixture(), member, true);
    query.eq(column, value);
    assert.deepEqual(query.data(), []);
  }
});

test('by-ID ownership and unfiltered listing remain constrained', () => {
  for (const isAdmin of [false, true]) {
    const { query } = scopeMemberResourceCategoryRead(queryFixture(), member, isAdmin);
    assert.deepEqual(query.data(), isAdmin ? rows.slice(0, 2) : [rows[0]]);
    query.eq('id', 'answer-own');
    assert.deepEqual(query.data(), [rows[0]]);
  }
  const { query } = scopeMemberResourceCategoryRead(queryFixture(), member, false);
  query.eq('id', 'answer-peer');
  assert.deepEqual(query.data(), []);
});

test('missing authentication, tenant, or member fails closed', () => {
  for (const [context, isAdmin] of [
    [{ ...member, isAuthenticated: false }, true],
    [{ ...member, tenantId: null }, true],
    [{ ...member, memberId: null }, false],
    [null, false],
  ]) {
    assert.equal(scopeMemberResourceCategoryRead(queryFixture(), context, isAdmin).error.status, 403);
  }
});

test('both generic GET handlers enforce the owner join independently of caller expand', () => {
  assert.equal(MEMBER_RESOURCE_CATEGORY_SELECT, '*,category_owner:member!inner()');
  for (const filename of ['index.js', '[id].js']) {
    const source = readFileSync(new URL(`../entities/[entity]/${filename}`, import.meta.url), 'utf8');
    const get = source.slice(source.indexOf("if (req.method === 'GET')"));
    assert.match(get, /entityNorm === 'memberresourcecategory' \? MEMBER_RESOURCE_CATEGORY_SELECT : expand \|\| '\*'/);
    assert.match(get, /scopeMemberResourceCategoryRead\(query, tenantCtx, await hasAdminAccess\(tenantCtx\)\)/);
    assert.match(get, /if \(scoped\.error\) return res\.status\(scoped\.error\.status\)/);
    assert.match(get, /shouldApplyTenantFilter && entityNorm !== 'memberresourcecategory'/);
  }
});