import test from 'node:test';
import assert from 'node:assert/strict';
import { createSalesProjectTasksHandler } from '../sales/project-tasks.js';
import { projectTaskOptions } from './salesProjects.js';
import { guardSalesLinkedProject } from './salesLinkedProjectGuard.js';

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const context = { isAuthenticated: true, tenantId: id(1), memberId: id(2), roleId: id(3) };
function fixture(overrides = {}) {
  const calls = [];
  const rows = {
    member: [{ id: id(2), tenant_id: id(1), identity_id: id(4) }],
    opportunity: [{ id: id(5), tenant_id: id(1), owner_kind: 'member', owner_id: id(2),
      name: 'Deal', organization_id: id(10), stage_id: id(11), version: 2, task_mode: 'standard' }],
    opportunity_collaborator: [],
    sales_opportunity_project: [],
    project_board: [{ id: id(6), tenant_id: id(1), name: 'Shared board', is_archived: false }],
    project_board_member: [{ board_id: id(6), identity_id: id(4), role: 'owner' }],
    organization: [{ id: id(10), tenant_id: id(1), name: 'Customer' }],
    opportunity_stage: [{ id: id(11), tenant_id: id(1), name: 'Open', is_active: true }],
    opportunity_loss_reason: [],
  };
  const db = {
    from(table) {
      const filters = [];
      const q = {
        select() { return q; },
        eq(key, value) { filters.push(row => row[key] === value); calls.push(['eq', table, key, value]); return q; },
        in(key, values) { filters.push(row => values.includes(row[key])); return q; },
        order() { return q; },
        maybeSingle() { return Promise.resolve({ data: (rows[table] || []).filter(row => filters.every(f => f(row)))[0] || null, error: null }); },
        then(resolve, reject) { return Promise.resolve({ data: (rows[table] || []).filter(row => filters.every(f => f(row))), error: null }).then(resolve, reject); },
      };
      return q;
    },
    async rpc(name, args) {
      calls.push(['rpc', name, args]);
      return { data: name === 'change_sales_project' ? { success: true }
        : { items: [], total: 0, summary: { total: 0, completed: 0, outstanding: 0, overdue: 0 } }, error: null };
    },
  };
  const handler = createSalesProjectTasksHandler({
    db, getTenantContext: async () => context, hasFeatureAccess: async () => true,
    hasAdminAccess: async () => false, ...overrides,
  });
  async function request(query = {}, body, method = body ? 'POST' : 'GET') {
    const res = { statusCode: 0, body: null, setHeader() {}, status(code) { this.statusCode = code; return this; },
      json(value) { this.body = value; return this; } };
    await handler({ method, query, body, url: '/api/sales/project-tasks' }, res);
    return res;
  }
  return { request, rows, calls, db };
}

test('default mode is preserved; server supplies permissions and identity, not caller flags', async () => {
  const f = fixture();
  const res = await f.request({ opportunityId: id(5) });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.taskMode, 'standard');
  assert.equal(res.body.board, null);
  assert.equal(res.body.permissions.canManage, true);
  const update = await f.request({}, { opportunityId: id(5), expectedVersion: 2, action: 'create',
    p_admin: true, p_identity: id(999), tenantId: id(999) });
  assert.equal(update.statusCode, 200);
  const [, , args] = f.calls.find(c => c[0] === 'rpc');
  assert.equal(args.p_admin, false);
  assert.equal(args.p_identity, id(4));
  assert.equal(args.p_tenant, id(1));
});

test('requests fail closed for authentication, tenant mismatch, Sales baseline and edit capability', async () => {
  for (const [ctx, hasFeatureAccess, expected] of [
    [{ ...context, isAuthenticated: false }, () => true, 401],
    [{ ...context, tenantMismatch: true }, () => true, 409],
    [{ ...context, tenantId: null }, () => true, 400],
    [context, () => false, 403],
    [context, (role, feature) => feature === 'sales.dashboard', 403],
    [{ ...context, memberExcludedFeatures: ['sales.opportunities.manage'] }, () => true, 403],
  ]) {
    const f = fixture({ getTenantContext: async () => ctx, hasFeatureAccess });
    const res = await f.request({}, { opportunityId: id(5), expectedVersion: 2, action: 'create' });
    assert.equal(res.statusCode, expected);
    assert.equal(f.calls.some(c => c[0] === 'rpc'), false);
  }
});

test('opportunity ownership, tenant scope, create-board permission and Board View are checked', async () => {
  for (const deny of ['ownership', 'tenant', 'projects.boards.create', 'projects.board-view']) {
    const f = fixture({ hasFeatureAccess: async (role, key) => key !== deny });
    if (deny === 'ownership') f.rows.opportunity[0].owner_id = id(9);
    if (deny === 'tenant') f.rows.opportunity[0].tenant_id = id(9);
    const res = await f.request({}, { opportunityId: id(5), expectedVersion: 2, action: 'create' });
    assert.equal(res.statusCode, ['ownership', 'tenant'].includes(deny) ? 404 : 403);
    assert.equal(f.calls.some(c => c[0] === 'rpc'), false);
  }
});

test('a denied Sales user cannot discover opportunity association via Projects', async () => {
  const f = fixture({ hasFeatureAccess: async () => false });
  const res = await f.request({ boardId: id(6) });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { opportunity: null });
  assert.equal(f.calls.length, 0);
});

test('board panel checks board membership AND opportunity permissions; projects cannot grant Sales visibility', async () => {
  for (const denied of ['board', 'opportunity', 'cross-tenant']) {
    const f = fixture();
    f.rows.sales_opportunity_project = [{ tenant_id: id(1), board_id: id(6), opportunity_id: id(5) }];
    if (denied === 'board') f.rows.project_board_member = [];
    if (denied === 'opportunity') f.rows.opportunity[0].owner_id = id(99);
    if (denied === 'cross-tenant') f.rows.project_board[0].tenant_id = id(99);
    const res = await f.request({ boardId: id(6) });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { opportunity: null });
  }
  const f = fixture();
  f.rows.sales_opportunity_project = [{ tenant_id: id(1), board_id: id(6), opportunity_id: id(5) }];
  const res = await f.request({ boardId: id(6) });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.opportunity.name, 'Deal');
  assert.equal(res.body.opportunity.organization.name, 'Customer');
  assert.equal(res.body.opportunity.permissions.canEdit, true);
  assert.equal(res.body.opportunity.tenant_id, undefined);
});

test('inaccessible linked board is redacted, can be unlinked without deleting board or tasks', async () => {
  const f = fixture();
  f.rows.sales_opportunity_project = [{ tenant_id: id(1), board_id: id(6), opportunity_id: id(5) }];
  f.rows.project_board_member = [];
  const res = await f.request({ opportunityId: id(5) });
  assert.equal(res.body.board, null);
  assert.equal(res.body.boardUnavailable, true);
  const unlink = await f.request({}, { opportunityId: id(5), action: 'unlink', expectedVersion: 2 });
  assert.equal(unlink.statusCode, 200);
  assert.equal(f.calls.find(c => c[0] === 'rpc')[2].p_action, 'unlink');
});

test('standard tasks do not require Projects access; project tasks do', async () => {
  const f = fixture({ hasFeatureAccess: async (role, feature) => !feature.startsWith('projects.') });
  assert.equal((await f.request({ view: 'tasks', source: 'standard' })).statusCode, 200);
  assert.equal((await f.request({ view: 'tasks', source: 'project' })).statusCode, 403);
  assert.equal((await f.request({}, { opportunityId: id(5), action: 'mode', taskMode: 'standard', expectedVersion: 2 })).statusCode, 200);
});

test('legacy non-UUID identity cannot enter UUID-backed Projects, standard tasks remain usable', async () => {
  const f = fixture();
  f.rows.member[0].identity_id = 'legacy-identity';
  assert.equal((await f.request({ opportunityId: id(5) })).body.permissions.canCreateBoard, false);
  assert.equal((await f.request({ view: 'tasks', source: 'standard' })).statusCode, 200);
  assert.equal((await f.request({ view: 'tasks', source: 'project' })).statusCode, 403);
});

test('filters validate dates, enums and bounded pagination, not SQL/PostgREST text', () => {
  const options = projectTaskOptions({ source: 'standard', scope: 'all', dueFrom: '2026-10-01',
    dueTo: '2026-10-31', sort: 'priority', page: '2', pageSize: '50' });
  assert.equal(options.page, 2);
  assert.equal(options.pageSize, 50);
  for (const query of [{ dueFrom: '2026-02-30' }, { dueTo: '2026-13-01' }, { pageSize: 101 },
    { source: 'other' }, { status: 'deleted' }, { scope: 'unrestricted' }, { sort: 'title;DROP' },
    { opportunityId: 'invalid' }, { overdue: 'yes' }, { dueFrom: '2026-10-31', dueTo: '2026-10-01' }]) {
    assert.throws(() => projectTaskOptions(query), error => error.status === 400);
  }
});

test('invalid commands never reach database mutations, including unauthorised board candidate discovery', async () => {
  for (const body of [
    { action: 'link', boardId: 'invalid', expectedVersion: 2 }, { action: 'destroy', expectedVersion: 2 },
    { action: 'mode', taskMode: 'both', expectedVersion: 2 }, { action: 'create' },
  ]) {
    const f = fixture();
    assert.equal((await f.request({}, { opportunityId: id(5), ...body })).statusCode, 400);
    assert.equal(f.calls.some(c => c[0] === 'rpc'), false);
  }
  const f = fixture({ hasFeatureAccess: async (role, feature) => feature !== 'sales.opportunities.manage' });
  assert.equal((await f.request({ view: 'boards', opportunityId: id(5) })).statusCode, 403);
});

test('linked-board task endpoints enforce Projects role/capabilities and tenant without requiring Sales', async () => {
  for (const scenario of ['allowed', 'ordinary', 'viewer', 'archived', 'missing membership', 'tenant', 'capability', 'anonymous']) {
    const f = fixture();
    f.rows.sales_opportunity_project = scenario === 'ordinary' ? []
      : [{ board_id: id(6), tenant_id: id(1) }];
    if (scenario === 'viewer') f.rows.project_board_member[0].role = 'viewer';
    if (scenario === 'archived') f.rows.project_board[0].is_archived = true;
    if (scenario === 'missing membership') f.rows.project_board_member = [];
    const ctx = scenario === 'tenant' ? { ...context, tenantId: id(99) }
      : scenario === 'anonymous' ? { ...context, isAuthenticated: false } : context;
    const response = { statusCode: null, status(n) { this.statusCode = n; return this; }, json() {} };
    const allowed = await guardSalesLinkedProject({ method: 'POST' }, response, id(6), 'projects.board-view.assign-cards', {
      db: f.db, getTenantContext: async () => ctx, hasAdminAccess: async () => false,
      hasFeatureAccess: async (role, feature) => feature.startsWith('projects.')
        && !(scenario === 'capability' && feature.endsWith('assign-cards')),
    });
    assert.equal(allowed, ['allowed', 'ordinary'].includes(scenario), scenario);
    if (!allowed) assert.equal(response.statusCode, scenario === 'anonymous' ? 401 : 403, scenario);
  }
});
