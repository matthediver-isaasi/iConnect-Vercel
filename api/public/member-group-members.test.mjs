import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildPublicGroupPayload,
  parseRequestedRoles,
  selectCurrentAssignments,
  parsePagination,
  handleMemberGroupMembers,
  MEMBER_ASSIGNMENT_SELECT,
  MEMBER_CARD_SELECT,
} from './member-group-members.js';

class FakeQuery {
  constructor(database, table) {
    this.database = database;
    this.table = table;
    this.filters = [];
    this.orders = [];
    this.selected = '*';
    this.selectOptions = {};
    this.limitValue = null;
    this.rangeValue = null;
    this.inFilters = [];
  }

  select(columns, options = {}) {
    this.selected = columns;
    this.selectOptions = options;
    return this;
  }

  eq(column, value) {
    this.filters.push((row) => this.valueFor(row, column) === value);
    return this;
  }

  neq(column, value) {
    this.filters.push((row) => row[column] != null && row[column] !== value);
    return this;
  }

  not(column, operator, value) {
    if (operator === 'is') {
      this.filters.push((row) => this.valueFor(row, column) !== value);
    }
    if (operator === 'ilike') {
      this.filters.push((row) => (
        !/^deleted_.*@deleted\.local$/i.test(String(this.valueFor(row, column) || ''))
      ));
    }
    return this;
  }

  is(column, value) {
    this.filters.push((row) => (
      value === null ? this.valueFor(row, column) == null : this.valueFor(row, column) === value
    ));
    return this;
  }

  in(column, values) {
    const allowed = new Set(values);
    this.inFilters.push({ column, values: [...values] });
    this.filters.push((row) => allowed.has(this.valueFor(row, column)));
    return this;
  }

  or(expression, options = {}) {
    if (expression.startsWith('expires_at.is.null,expires_at.gt.')) {
      const now = Date.parse(expression.slice('expires_at.is.null,expires_at.gt.'.length));
      this.filters.push((row) => row.expires_at == null || Date.parse(row.expires_at) > now);
    } else if (expression === 'show_in_directory.is.null,show_in_directory.neq.false') {
      this.filters.push((row) => {
        const target = options.referencedTable === 'member' ? this.memberFor(row) : row;
        return target?.show_in_directory == null || target.show_in_directory !== false;
      });
    } else if (expression === 'login_enabled.is.null,login_enabled.neq.false') {
      this.filters.push((row) => {
        const target = options.referencedTable === 'member' ? this.memberFor(row) : row;
        return target?.login_enabled == null || target.login_enabled !== false;
      });
    }
    return this;
  }

  order(column, options = {}) {
    this.orders.push({
      column,
      ascending: options.ascending !== false,
      referencedTable: options.referencedTable,
    });
    return this;
  }

  limit(value) {
    this.limitValue = value;
    return this;
  }

  range(from, to) {
    this.rangeValue = [from, to];
    return this;
  }

  then(resolve, reject) {
    return Promise.resolve(this.execute()).then(resolve, reject);
  }

  memberFor(row) {
    if (this.table === 'member') return row;
    return this.database.memberById.get(row.member_id) || null;
  }

  valueFor(row, column, referencedTable) {
    if (column.startsWith('member.')) {
      return this.memberFor(row)?.[column.slice('member.'.length)];
    }
    if (referencedTable === 'member') return this.memberFor(row)?.[column];
    return row[column];
  }

  execute() {
    const isJoinedMemberPage = this.table === 'member_group_assignment'
      && String(this.selected).includes('member:member!inner');
    const failureKey = isJoinedMemberPage ? 'memberPage' : this.table;
    this.database.trace.push({
      table: this.table,
      selected: this.selected,
      head: !!this.selectOptions.head,
      range: this.rangeValue,
      orders: this.orders,
      inFilters: this.inFilters,
    });
    if (this.database.failures[failureKey]) {
      return { data: null, count: null, error: { message: `${failureKey} failed` } };
    }

    let rows = [...(this.database.tables[this.table] || [])];
    for (const filter of this.filters) rows = rows.filter(filter);
    if (this.orders.length > 0) {
      rows.sort((left, right) => {
        for (const { column, ascending, referencedTable } of this.orders) {
          const leftValue = this.valueFor(left, column, referencedTable);
          const rightValue = this.valueFor(right, column, referencedTable);
          const a = leftValue == null ? '' : String(leftValue);
          const b = rightValue == null ? '' : String(rightValue);
          const compared = a.localeCompare(b);
          if (compared !== 0) return ascending ? compared : -compared;
        }
        return 0;
      });
    }
    const count = rows.length;
    if (this.rangeValue) rows = rows.slice(this.rangeValue[0], this.rangeValue[1] + 1);
    if (this.limitValue != null) rows = rows.slice(0, this.limitValue);

    if (this.selectOptions.head) return { data: null, count, error: null };
    if (isJoinedMemberPage) {
      const nestedColumns = String(this.selected)
        .match(/member:member!inner\(([^)]+)\)/)?.[1]
        .split(',')
        .map((column) => column.trim()) || [];
      rows = rows.map((assignment) => {
        const member = this.memberFor(assignment);
        return {
          group_role: assignment.group_role,
          member: member
            ? Object.fromEntries(nestedColumns.map((column) => [column, member[column]]))
            : null,
        };
      });
      return { data: rows, count: this.selectOptions.count ? count : null, error: null };
    }
    const columns = String(this.selected)
      .split(',')
      .map((column) => column.trim())
      .filter((column) => column && !column.includes('('));
    if (columns.length && this.selected !== '*') {
      rows = rows.map((row) => Object.fromEntries(columns.map((column) => [column, row[column]])));
    }
    return { data: rows, count: this.selectOptions.count ? count : null, error: null };
  }
}

function fakeSupabase(tables, failures = {}) {
  const database = {
    tables,
    failures,
    trace: [],
    memberById: new Map((tables.member || []).map((member) => [member.id, member])),
  };
  return {
    trace: database.trace,
    from(table) {
      return new FakeQuery(database, table);
    },
  };
}

function fakeResponse() {
  return {
    statusCode: 200,
    body: undefined,
    headers: {},
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    end() {
      return this;
    },
  };
}

function baseTables(overrides = {}) {
  return {
    member_group: [{
      id: 'group-1',
      tenant_id: 'tenant-1',
      name: 'Leadership',
      description: '<p>Leaders</p>',
      roles: ['Chair', 'Member'],
      is_active: true,
    }],
    member_group_assignment: [],
    member: [],
    organization: [],
    system_settings: [],
    ...overrides,
  };
}

async function requestEndpoint({ query = {}, tables, failures, tenant = { id: 'tenant-1' } }) {
  const supabase = fakeSupabase(tables || baseTables(), failures);
  const req = { method: 'GET', query };
  const res = fakeResponse();
  await handleMemberGroupMembers(req, res, { supabase, tenant });
  return { res, supabase };
}

test('member card select exposes safe directory fields only (no email)', () => {
  assert.ok(MEMBER_CARD_SELECT.includes('first_name'));
  assert.ok(MEMBER_CARD_SELECT.includes('profile_photo_url'));
  assert.ok(MEMBER_CARD_SELECT.includes('organization_id'));
  // Contact/PII fields beyond directory-safe ones must not leak.
  assert.ok(!MEMBER_CARD_SELECT.includes('email'));
  assert.ok(!MEMBER_CARD_SELECT.includes('phone'));
  assert.ok(MEMBER_ASSIGNMENT_SELECT.includes('member:member!inner'));
  assert.ok(!MEMBER_ASSIGNMENT_SELECT.includes('email'));
});

test('parseRequestedRoles returns null when no filter is supplied', () => {
  assert.equal(parseRequestedRoles(undefined), null);
  assert.equal(parseRequestedRoles(null), null);
});

test('parseRequestedRoles splits, trims, and de-duplicates a CSV', () => {
  assert.deepEqual(
    parseRequestedRoles('Chair, Member , Chair'),
    ['Chair', 'Member']
  );
  // Empty tokens are dropped.
  assert.deepEqual(parseRequestedRoles('Chair,,'), ['Chair']);
  // An empty string yields an empty list (an explicit, honoured filter).
  assert.deepEqual(parseRequestedRoles(''), []);
});

test('parseRequestedRoles accepts a repeated (array) query param', () => {
  assert.deepEqual(
    parseRequestedRoles(['Chair', ' Vice Chair ', 'Chair']),
    ['Chair', 'Vice Chair']
  );
});

test('buildPublicGroupPayload exposes public metadata and normalises collections', () => {
  const payload = buildPublicGroupPayload({
    id: 'g1',
    name: 'Advisory Board',
    description: 'desc',
    roles: ['Chair', null, 'Member'],
    is_active: true,
  });
  assert.equal(payload.id, 'g1');
  assert.equal(payload.name, 'Advisory Board');
  // Falsy entries are filtered from the role collection.
  assert.deepEqual(payload.roles, ['Chair', 'Member']);
  assert.deepEqual(Object.keys(payload).sort(), ['description', 'id', 'name', 'roles']);
});

test('buildPublicGroupPayload defaults collections and rejects bad shapes', () => {
  const payload = buildPublicGroupPayload({ id: 'g2', name: 'Bare' });
  assert.deepEqual(payload.roles, []);
  assert.equal(payload.description, null);
  assert.equal(buildPublicGroupPayload(null), null);
});

test('current assignment selection excludes guests, expired rows, and stale roles', () => {
  const now = Date.parse('2026-08-19T12:00:00.000Z');
  const selected = selectCurrentAssignments([
    { member_id: 'visible', group_role: 'Chair', expires_at: null },
    { member_id: 'guest', guest_id: 'guest-1', group_role: 'Chair' },
    { member_id: 'expired', group_role: 'Member', expires_at: '2026-08-18' },
    { member_id: 'invalid-expiry', group_role: 'Member', expires_at: 'not-a-date' },
    { member_id: 'stale-role', group_role: 'Old role', expires_at: null },
    { member_id: null, group_role: 'Member', expires_at: null },
  ], ['Chair', 'Member'], null, now);

  assert.deepEqual([...selected.keys()], ['visible']);
  assert.deepEqual(selected.get('visible'), { groupRole: 'Chair', isGroupAdmin: false });
});

test('current assignment selection applies only valid requested group roles', () => {
  const selected = selectCurrentAssignments([
    { member_id: 'chair', group_role: 'Chair', is_group_admin: true },
    { member_id: 'member', group_role: 'Member' },
  ], ['Chair', 'Member'], ['Chair'], Date.parse('2026-08-19T12:00:00.000Z'));

  assert.deepEqual([...selected.keys()], ['chair']);
  assert.deepEqual(selected.get('chair'), { groupRole: 'Chair', isGroupAdmin: true });
});

test('pagination is bounded and produces deterministic range offsets', () => {
  assert.deepEqual(parsePagination('1', '6'), { pageNum: 1, pageSize: 6, offset: 0 });
  assert.deepEqual(parsePagination('3', '6'), { pageNum: 3, pageSize: 6, offset: 12 });
  assert.deepEqual(parsePagination('0', '1000'), { pageNum: 1, pageSize: 50, offset: 0 });
  assert.deepEqual(parsePagination('bad', 'bad'), { pageNum: 1, pageSize: 12, offset: 0 });
});

test('handler paginates beyond 1000 assignments without an unbounded member-id filter', async () => {
  const assignments = Array.from({ length: 1001 }, (_, index) => ({
    tenant_id: 'tenant-1',
    group_id: 'group-1',
    member_id: `member-${String(index).padStart(4, '0')}`,
    guest_id: null,
    group_role: 'Member',
    expires_at: null,
  }));
  const members = assignments.map((assignment) => ({
    id: assignment.member_id,
    tenant_id: 'tenant-1',
    first_name: assignment.member_id,
    email: `${assignment.member_id}@example.test`,
  }));
  const { res, supabase } = await requestEndpoint({
    query: { groupId: 'group-1', page: '21', limit: '50' },
    tables: baseTables({ member_group_assignment: assignments, member: members }),
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.total, 1001);
  assert.equal(res.body.records.length, 1);
  assert.equal(res.body.records[0].id, 'member-1000');

  const joinedQuery = supabase.trace.find(
    (entry) => entry.table === 'member_group_assignment'
      && entry.selected.includes('member:member!inner')
  );
  assert.deepEqual(joinedQuery.range, [1000, 1049]);
  assert.deepEqual(joinedQuery.inFilters, [{ column: 'group_role', values: ['Chair', 'Member'] }]);
});

test('handler rejects inactive and cross-tenant groups', async () => {
  const crossTenant = await requestEndpoint({
    query: { groupId: 'group-2' },
    tables: baseTables({
      member_group: [{
        id: 'group-2',
        tenant_id: 'tenant-2',
        name: 'Other tenant',
        roles: ['Member'],
        is_active: true,
      }],
    }),
  });
  assert.equal(crossTenant.res.statusCode, 404);

  const inactive = await requestEndpoint({
    query: { groupId: 'group-1' },
    tables: baseTables({
      member_group: [{
        id: 'group-1',
        tenant_id: 'tenant-1',
        name: 'Inactive',
        roles: ['Member'],
        is_active: false,
      }],
    }),
  });
  assert.equal(inactive.res.statusCode, 404);
});

test('handler rejects a role not configured on the selected group', async () => {
  const { res } = await requestEndpoint({
    query: { groupId: 'group-1', roles: 'Treasurer' },
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /Treasurer/);
});

test('handler applies a valid configured role filter to the joined page', async () => {
  const { res } = await requestEndpoint({
    query: { groupId: 'group-1', roles: 'Chair' },
    tables: baseTables({
      member_group_assignment: [
        { tenant_id: 'tenant-1', group_id: 'group-1', member_id: 'chair', guest_id: null, group_role: 'Chair', expires_at: null },
        { tenant_id: 'tenant-1', group_id: 'group-1', member_id: 'member', guest_id: null, group_role: 'Member', expires_at: null },
      ],
      member: [
        { id: 'chair', tenant_id: 'tenant-1', first_name: 'Chair', email: 'chair@example.test' },
        { id: 'member', tenant_id: 'tenant-1', first_name: 'Member', email: 'member@example.test' },
      ],
    }),
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.total, 1);
  assert.deepEqual(res.body.records.map((record) => record.id), ['chair']);
  assert.equal(res.body.records[0].group_role, 'Chair');
});

test('handler enforces assignment and directory privacy before deterministic pagination', async () => {
  const assignments = [
    { tenant_id: 'tenant-1', group_id: 'group-1', member_id: 'm1', guest_id: null, group_role: 'Chair', expires_at: null },
    { tenant_id: 'tenant-1', group_id: 'group-1', member_id: 'm2', guest_id: null, group_role: 'Member', expires_at: null },
    { tenant_id: 'tenant-1', group_id: 'group-1', member_id: 'm3', guest_id: null, group_role: 'Member', expires_at: null },
    { tenant_id: 'tenant-1', group_id: 'group-1', member_id: 'hidden', guest_id: null, group_role: 'Member', expires_at: null },
    { tenant_id: 'tenant-1', group_id: 'group-1', member_id: 'disabled', guest_id: null, group_role: 'Member', expires_at: null },
    { tenant_id: 'tenant-1', group_id: 'group-1', member_id: 'deleted', guest_id: null, group_role: 'Member', expires_at: null },
    { tenant_id: 'tenant-1', group_id: 'group-1', member_id: 'expired', guest_id: null, group_role: 'Member', expires_at: '2020-01-01' },
    { tenant_id: 'tenant-1', group_id: 'group-1', member_id: 'guest-row', guest_id: 'guest-1', group_role: 'Member', expires_at: null },
    { tenant_id: 'tenant-1', group_id: 'group-1', member_id: 'stale', guest_id: null, group_role: 'Former role', expires_at: null },
  ];
  const membersForTest = [
    { id: 'm3', tenant_id: 'tenant-1', first_name: 'Katherine', last_name: 'Johnson', email: 'k@example.test' },
    { id: 'm1', tenant_id: 'tenant-1', first_name: 'Ada', last_name: 'Lovelace', email: 'a@example.test', organization_id: 'org-1' },
    { id: 'm2', tenant_id: 'tenant-1', first_name: 'Grace', last_name: 'Hopper', email: 'g@example.test' },
    { id: 'hidden', tenant_id: 'tenant-1', first_name: 'Hidden', email: 'h@example.test', show_in_directory: false },
    { id: 'disabled', tenant_id: 'tenant-1', first_name: 'Disabled', email: 'd@example.test', login_enabled: false },
    { id: 'deleted', tenant_id: 'tenant-1', first_name: 'Deleted', email: 'deleted_1@deleted.local' },
  ];
  const { res, supabase } = await requestEndpoint({
    query: { groupId: 'group-1', page: '2', limit: '2' },
    tables: baseTables({
      member_group_assignment: assignments,
      member: membersForTest,
      organization: [{ id: 'org-1', name: 'Analytical Society' }],
    }),
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.total, 3);
  assert.equal(res.body.page, 2);
  assert.equal(res.body.pageSize, 2);
  assert.deepEqual(res.body.records.map((record) => record.first_name), ['Katherine']);
  assert.equal(res.body.records[0].group_role, 'Member');
  assert.equal('email' in res.body.records[0], false);
  assert.deepEqual(Object.keys(res.body.config.group).sort(), ['description', 'id', 'name', 'roles']);

  const dataQuery = supabase.trace.find(
    (entry) => entry.table === 'member_group_assignment'
      && entry.selected.includes('member:member!inner')
  );
  assert.deepEqual(dataQuery.range, [2, 3]);
  assert.deepEqual(dataQuery.orders.map((order) => order.column), ['first_name', 'last_name', 'id']);
});

test('handler fails explicitly when the joined count/page query fails', async () => {
  const { res } = await requestEndpoint({
    query: { groupId: 'group-1' },
    tables: baseTables({
      member_group_assignment: [{
        tenant_id: 'tenant-1',
        group_id: 'group-1',
        member_id: 'm1',
        guest_id: null,
        group_role: 'Chair',
      }],
      member: [{ id: 'm1', tenant_id: 'tenant-1', first_name: 'Ada', email: 'a@example.test' }],
    }),
    failures: { memberPage: true },
  });
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.error, 'Failed to fetch members');
});
