import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyCommunicationReportMemberFilters,
  buildCommunicationReportSearchFilter,
  fetchAllCommunicationReportRows,
  loadCommunicationStatusReport,
} from '../../_lib/memberCommunicationStatusReport.js';
import { handleCommunicationStatusReport } from './status-report.js';

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test('report rejects callers without communications administration permission', async () => {
  let queried = false;
  const res = responseRecorder();
  await handleCommunicationStatusReport({ method: 'GET', query: {} }, res, {
    database: { from() { queried = true; throw new Error('must not query'); } },
    getTenantContext: async () => ({
      isAuthenticated: true,
      tenantId: 'tenant-a',
      roleId: 'role-a',
    }),
    hasAdminAccess: async () => false,
    hasFeatureAccess: async () => false,
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, 'Permission denied');
  assert.equal(queried, false);
});

test('report rejects unauthenticated callers before querying', async () => {
  let queried = false;
  const res = responseRecorder();
  await handleCommunicationStatusReport({ method: 'GET', query: {} }, res, {
    database: { from() { queried = true; throw new Error('must not query'); } },
    getTenantContext: async () => ({ isAuthenticated: false }),
  });
  assert.equal(res.statusCode, 401);
  assert.equal(queried, false);
});

test('report returns a retryable server error when bounded loading fails', async () => {
  const res = responseRecorder();
  await handleCommunicationStatusReport({ method: 'GET', query: {} }, res, {
    database: {},
    getTenantContext: async () => ({ isAuthenticated: true, tenantId: 'tenant-a' }),
    hasAdminAccess: async () => true,
    hasFeatureAccess: async () => false,
    loadCommunicationStatusReport: async () => {
      throw new Error('database failed');
    },
  });
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { error: 'Failed to load communication status report' });
});

test('bounded report loader reads stable pages beyond the 1,000-row database cap', async () => {
  const source = Array.from({ length: 2205 }, (_, index) => ({ id: index + 1 }));
  const ranges = [];
  const rows = await fetchAllCommunicationReportRows(() => ({
    order(column, options) {
      assert.equal(column, 'id');
      assert.deepEqual(options, { ascending: true });
      return this;
    },
    async range(from, to) {
      ranges.push([from, to]);
      return { data: source.slice(from, to + 1), error: null };
    },
  }));
  assert.equal(rows.length, 2205);
  assert.deepEqual(ranges, [[0, 999], [1000, 1999], [2000, 2999]]);
});

test('search preserves punctuation as escaped regex literals in a quoted PostgREST OR value', () => {
  const filter = buildCommunicationReportSearchFilter('o"reilly,*_100%.js\\x');
  assert.equal((filter.match(/(?:first_name|last_name|email)\.imatch\./g) || []).length, 3);
  assert.match(filter, /^first_name\.imatch\."/);
  assert.ok(filter.includes('o\\"reilly,\\\\*_100%\\\\.js'));
  assert.doesNotMatch(filter, /\.ilike\./);
});

test('deleted-member exclusion is grouped with NULL-email inclusion under tenant scope', () => {
  const calls = [];
  const query = {
    eq(...args) { calls.push(['eq', ...args]); return this; },
    or(...args) { calls.push(['or', ...args]); return this; },
  };
  applyCommunicationReportMemberFilters(query, {
    search: '',
    organizationId: '',
    roleId: '',
    globalOptOut: 'all',
    categoryId: '',
    categoryStatus: '',
  }, 'tenant-a');
  assert.deepEqual(calls, [
    ['eq', 'tenant_id', 'tenant-a'],
    ['or', 'email.is.null,email.not.like.deleted\\_%@deleted.local'],
  ]);
});

function reportDatabaseFixture({ members, preferences }) {
  class Query {
    constructor(table) {
      this.table = table;
      this.equals = [];
      this.notFilters = [];
      this.orFilters = [];
      this.inFilters = [];
      this.isFilters = [];
      this.orders = [];
      this.from = 0;
      this.to = null;
      this.countOptions = null;
    }
    select(value, options) { this.selectValue = value; this.countOptions = options; return this; }
    eq(column, value) { this.equals.push([column, value]); return this; }
    not(column, operator, value) { this.notFilters.push([column, operator, value]); return this; }
    or(value) { this.orFilters.push(value); return this; }
    in(column, values) { this.inFilters.push([column, values]); return this; }
    is(column, value) { this.isFilters.push([column, value]); return this; }
    order(column, options) { this.orders.push([column, options]); return this; }
    range(from, to) { this.from = from; this.to = to; return this.execute(); }
    then(resolve, reject) { return this.execute().then(resolve, reject); }
    async execute() {
      if (this.table === 'member_communication_preference') {
        let rows = preferences.slice();
        for (const [column, value] of this.equals) rows = rows.filter((row) => row[column] === value);
        for (const [column, values] of this.inFilters) rows = rows.filter((row) => values.includes(row[column]));
        rows.sort((a, b) => String(a.id).localeCompare(String(b.id)));
        const end = this.to === null ? rows.length : this.to + 1;
        return { data: rows.slice(this.from, end), error: null };
      }
      let rows = members.slice();
      for (const [column, value] of this.equals) {
        if (!column.includes('.')) rows = rows.filter((row) => row[column] === value);
      }
      rows = rows.filter((row) => !/^deleted_.*@deleted\.local$/i.test(row.email));
      const categoryId = this.equals.find(([key]) => key === 'category_filter.category_id')?.[1];
      const categoryTenant = this.equals.find(([key]) => key === 'category_filter.tenant_id')?.[1];
      const hasCategoryOptIn = (member) => preferences.some((preference) =>
        preference.member_id === member.id
        && preference.tenant_id === categoryTenant
        && preference.category_id === categoryId
        && preference.is_subscribed === true);
      if (categoryId) {
        const antiJoin = this.isFilters.some(([key, value]) => key === 'category_filter' && value === null);
        rows = rows.filter((member) => antiJoin ? !hasCategoryOptIn(member) : hasCategoryOptIn(member));
      }
      if (this.selectValue?.includes('any_opt_in:')) {
        const tenant = this.equals.find(([key]) => key === 'any_opt_in.tenant_id')?.[1];
        rows = rows.filter((member) => preferences.some((preference) =>
          preference.member_id === member.id
          && preference.tenant_id === tenant
          && preference.is_subscribed === true));
      }
      for (const filter of this.orFilters) {
        if (filter.includes('communications_opted_out_all')) {
          rows = rows.filter((row) => row.communications_opted_out_all !== true);
        }
      }
      rows.sort((a, b) =>
        String(a.last_name || '').localeCompare(String(b.last_name || ''))
        || String(a.first_name || '').localeCompare(String(b.first_name || ''))
        || String(a.id).localeCompare(String(b.id)));
      const count = rows.length;
      if (this.countOptions?.head) return { data: null, count, error: null };
      const end = this.to === null ? rows.length : this.to + 1;
      return { data: rows.slice(this.from, end), count, error: null };
    }
  }
  return { from(table) { return new Query(table); } };
}

const definitions = {
  categories: [{
    id: 'category-a',
    name: 'Updates',
    display_order: 1,
    is_active: true,
    member_enabled: true,
  }],
  rolesByCategory: new Map([['category-a', ['role-a']]]),
  organizations: [{ id: 'org-a', name: 'Tenant A Org' }],
  roles: [{ id: 'role-a', name: 'Tenant A Role' }],
};

test('filter intersections and exact summaries cover disabled members but exclude deleted/cross-tenant rows', async () => {
  const members = [
    { id: 'm1', tenant_id: 'tenant-a', first_name: 'Active', last_name: 'One', email: 'one@test', organization_id: 'org-a', role_id: 'role-a', login_enabled: true, communications_opted_out_all: true },
    { id: 'm2', tenant_id: 'tenant-a', first_name: 'Disabled', last_name: 'Two', email: 'two@test', organization_id: 'org-cross-tenant', role_id: 'role-cross-tenant', login_enabled: false, communications_opted_out_all: false },
    { id: 'm3', tenant_id: 'tenant-a', first_name: 'Deleted', last_name: 'Three', email: 'deleted_m3@deleted.local', organization_id: 'org-a', role_id: 'role-a', login_enabled: false, communications_opted_out_all: false },
    { id: 'm4', tenant_id: 'tenant-b', first_name: 'Other', last_name: 'Tenant', email: 'other@test', organization_id: 'org-a', role_id: 'role-a', login_enabled: true, communications_opted_out_all: false },
    { id: 'm5', tenant_id: 'tenant-a', first_name: 'No', last_name: 'Email', email: null, organization_id: 'org-a', role_id: 'role-a', login_enabled: true, communications_opted_out_all: false },
  ];
  const preferences = [
    { id: 'p1', tenant_id: 'tenant-a', member_id: 'm1', category_id: 'category-a', is_subscribed: true },
    { id: 'p-cross', tenant_id: 'tenant-b', member_id: 'm2', category_id: 'category-a', is_subscribed: true },
  ];
  const database = reportDatabaseFixture({ members, preferences });

  const report = await loadCommunicationStatusReport(database, {
    tenantId: 'tenant-a',
    definitions,
    query: {},
  });
  assert.equal(report.pagination.total, 3);
  assert.deepEqual(report.summary, {
    filteredMembers: 3,
    globallyOptedOut: 1,
    notGloballyOptedOut: 2,
    anyExplicitCategoryOptIn: 1,
    withAnyCategoryOptIn: 1,
  });
  assert.equal(report.rows.find((row) => row.memberId === 'm2').loginEnabled, false);
  assert.equal(report.rows.find((row) => row.memberId === 'm2').organizationName, '');
  assert.equal(report.rows.find((row) => row.memberId === 'm2').roleName, '');
  assert.equal(report.rows.find((row) => row.memberId === 'm5').email, '');

  const intersection = await loadCommunicationStatusReport(database, {
    tenantId: 'tenant-a',
    definitions,
    query: {
      organizationId: 'org-a',
      roleId: 'role-a',
      globalOptOut: 'yes',
      categoryId: 'category-a',
      categoryStatus: 'opted_in',
    },
  });
  assert.equal(intersection.pagination.total, 1);
  assert.deepEqual(intersection.rows.map((row) => row.memberId), ['m1']);
  assert.equal(intersection.summary.globallyOptedOut, 1);
  assert.equal(intersection.summary.notGloballyOptedOut, 0);
});

test('tenant-owned category validation rejects a cross-tenant category and empty pages retain exact totals', async () => {
  const database = reportDatabaseFixture({
    members: [{ id: 'm1', tenant_id: 'tenant-a', email: 'one@test', login_enabled: false }],
    preferences: [],
  });
  await assert.rejects(
    loadCommunicationStatusReport(database, {
      tenantId: 'tenant-a',
      definitions,
      query: { categoryId: 'category-from-tenant-b', categoryStatus: 'not_opted_in' },
    }),
    (error) => error.status === 400 && /Unknown communication category/.test(error.message),
  );
  const emptyPage = await loadCommunicationStatusReport(database, {
    tenantId: 'tenant-a',
    definitions,
    query: { page: 2, limit: 1 },
  });
  assert.equal(emptyPage.rows.length, 0);
  assert.equal(emptyPage.pagination.total, 1);
  assert.equal(emptyPage.pagination.totalPages, 1);
});